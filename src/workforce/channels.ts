import { DatabaseSync } from 'node:sqlite';
import type { MaEnvironments } from './ma-environments.ts';
import type { WorkspaceMemories } from './workspace-memories.ts';
import type { MemoryOrganizer } from './memory-organizer.ts';
import { SessionMemory } from './session-memory.ts';
import { MaMemoryApi } from './ma-memory.ts';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { MaConfiguration } from './ma-config.ts';
import { MaSkills } from './ma-skills.ts';
import { missingConversationScopes, hasGroupEventScope } from './channel-permissions.ts';
import { resolve } from 'node:path';
import { registerApp, Client } from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import { ArkClient } from '../ark.ts';
import { createEmployeeRuntime } from '../employee-runtime.ts';
import { employeeAgentConfiguration, employeeConfigurationHash } from './agent-configuration.ts';
import { EMPLOYEE_CALENDAR_USER_SCOPES } from '../employee-auth.ts';
import { resolveLarkBotScopes } from '../scopes.ts';
import { DEFAULT_LARK_DOMAINS } from '../init.ts';
import { GatewayStore } from '../store.ts';
import { LarkChannelAdapter } from '../lark-channel.ts';
import { startChannelAfterRecovery } from '../channel-startup.ts';
import { DomainError } from './domain.ts';
import type { LocalWorkspace } from './workspace.ts';
import { createLarkChannel } from '@larksuite/channel';
import { registerGroupEvents } from './group-event-adapter.ts';
import { syncBotGroup, syncMessageGroup } from './group-events.ts';

type Binding = {
  employeeId: string;
  status: string;
  message?: string;
  url?: string;
  expiresAt?: number;
  appId?: string;
  appSecret?: string;
  creatorId?: string;
  agentId?: string;
  environmentId?: string;
  vaultId?: string;
  runtimeVersion?: number;
  configurationHash?: string;
  agentVersion?: string;
  syncedAt?: string;
  credentialId?: string;
  permissionsVersion?: number;
  permissionWarnings?: string[];
  groupEventsAuthorized?: boolean;
  pendingResource?: string;
  lastReceivedAt?: string;
  lastRepliedAt?: string;
};
type Options = {
  dataDir: string;
  register?: typeof registerApp;
  fetcher?: typeof fetch;
  ark?: () => ArkClient;
  provision?: (binding: Binding, checkpoint: () => void) => Promise<void>;
  connect?: (binding: Binding) => Promise<() => Promise<void>>;
};

// 复用 CLI 的二维码编码器，只输出黑白模块，不向第三方二维码服务发送链接。
export function qrModules(url: string) {
  const qr = new QRCode(-1, 1);
  qr.addData(url);
  qr.make();
  return qr.modules;
}

export class WorkspaceChannels {
  organizer?: MemoryOrganizer;
  memories?: WorkspaceMemories;
  environments?: MaEnvironments;
  private workspace: LocalWorkspace;
  private options: Options;
  private active = new Map<string, AbortController>();
  private importingApps = new Set<string>();
  private synchronizing = new Map<string, Promise<any>>();
  private running = new Map<string, () => Promise<void>>();
  private jobs = new Set<Promise<void>>();
  private closed = false;
  private initializationPaused = false;
  constructor(workspace: LocalWorkspace, options: Options) {
    this.workspace = workspace;
    this.options = options;
    workspace.db.exec(
      'CREATE TABLE IF NOT EXISTS workspace_channels (employee_id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
    );
    for (const row of this.all()) {
      row.url = undefined;
      row.expiresAt = undefined;
      row.status = row.appId ? 'stopped' : 'interrupted';
      row.message = row.appId ? '绑定已保留，等待启动' : '创建中断，请核查飞书是否已创建应用后重新接入';
      this.put(row);
    }
  }
  private all(): Binding[] {
    return this.workspace.db
      .prepare('SELECT payload FROM workspace_channels')
      .all()
      .map((r: any) => JSON.parse(r.payload));
  }
  private get(id: string): Binding | undefined {
    const row = this.workspace.db
      .prepare('SELECT payload FROM workspace_channels WHERE employee_id=?')
      .get(id) as any;
    return row ? JSON.parse(row.payload) : undefined;
  }
  private put(binding: Binding) {
    this.workspace.db
      .prepare('INSERT OR REPLACE INTO workspace_channels VALUES (?,?)')
      .run(binding.employeeId, JSON.stringify(binding));
  }
  upgradePermissions(id: string) {
    this.employee(id);
    const b = this.get(id);
    if (!b?.appId) throw new DomainError('请先创建并绑定飞书应用');
    if (this.closed || this.initializationPaused) throw new DomainError('服务正在关闭或初始化', 503);
    if (this.active.has(id)) return this.view(id);
    if (this.running.has(id)) throw new DomainError('请先重启本机服务，再补齐权限', 409);
    const controller = new AbortController();
    this.active.set(id, controller);
    b.status = 'upgrading_permissions';
    b.message = '正在生成现有应用的权限确认链接';
    this.put(b);
    const job = (async () => {
      try {
        const result = await (this.options.register || registerApp)({
          appId: b.appId,
          source: 'workforce-workforce-upgrade',
          signal: controller.signal,
          addons: {
            scopes: {
              tenant: resolveLarkBotScopes(DEFAULT_LARK_DOMAINS),
              user: EMPLOYEE_CALENDAR_USER_SCOPES,
            },
            events: {
              items: {
                tenant: [
                  'im.message.receive_v1',
                  'im.chat.member.bot.added_v1',
                  'im.chat.member.bot.deleted_v1',
                ],
              },
            },
          },
          onQRCodeReady: (info) => {
            if (this.closed) return;
            Object.assign(b, {
              url: info.url,
              expiresAt: Date.now() + info.expireIn * 1000,
              status: 'awaiting_permission_confirmation',
              message: '请扫码为现有飞书应用补齐权限，不会新建应用',
            });
            this.put(b);
          },
        });
        if (result.client_id !== b.appId || !result.client_secret) throw new Error('应用身份不匹配');
        b.appSecret = result.client_secret;
        b.permissionsVersion = 2;
        b.status = 'provisioning';
        b.message = '权限确认已完成，正在核查权限并升级运行时';
        b.url = undefined;
        b.expiresAt = undefined;
        this.put(b);
        await this.setup(b, this.employee(id).name, controller);
      } catch {
        b.status = 'awaiting_permissions';
        b.message = '权限确认未完成，原应用绑定已保留，可重新补齐权限';
      } finally {
        b.url = undefined;
        b.expiresAt = undefined;
        this.put(b);
        this.active.delete(id);
        this.jobs.delete(job);
      }
    })();
    this.jobs.add(job);
    return this.view(id);
  }
  private employee(id: string) {
    const employee = this.workspace.read().state.employees.find((e: any) => e.id === id);
    if (!employee) throw new DomainError('数字员工不存在', 404);
    return employee;
  }
  view(id: string) {
    this.employee(id);
    const b = this.get(id);
    if (!b)
      return { employeeId: id, status: 'unbound', message: '新建飞书应用，或使用已有企业自建应用接入此员工' };
    // 白名单返回字段，App Secret 和 MA 内部配置不能通过工作台接口读出。
    return {
      employeeId: id,
      status: b.status,
      message: b.message,
      appId: b.appId,
      url: b.url,
      expiresAt: b.expiresAt,
      qr: b.url ? qrModules(b.url) : undefined,
      lastReceivedAt: b.lastReceivedAt,
      lastRepliedAt: b.lastRepliedAt,
      permissionsVersion: b.permissionsVersion || 1,
      permissionWarnings: b.permissionWarnings || [],
      groupEventsAuthorized: b.groupEventsAuthorized,
      environmentId: b.environmentId,
      agentId: b.agentId,
      agentVersion: b.agentVersion,
      syncedAt: b.syncedAt,
      configurationSynced:
        !!b.agentId && b.configurationHash === employeeConfigurationHash(this.employee(id)),
    };
  }
  runtimeConfig(id: string) {
    const b = this.get(id);
    this.employee(id);
    if (!b?.agentId || !b.environmentId) throw new DomainError('请先完成该员工的 MA 与飞书接入', 409);
    return {
      agentId: b.agentId,
      environmentId: this.employee(id).environment.maEnvironmentId || b.environmentId,
    };
  }
  async syncAgent(id: string) {
    const existing = this.synchronizing.get(id);
    if (existing) return existing;
    const job = this.performSync(id).finally(() => this.synchronizing.delete(id));
    this.synchronizing.set(id, job);
    return job;
  }
  private async performSync(id: string) {
    const employee = this.employee(id);
    const binding = this.get(id);
    if (this.closed || this.initializationPaused || this.active.has(id))
      throw new DomainError('员工接入进行中，请稍后同步', 409);
    if (!binding?.agentId) throw new DomainError('请先完成飞书接入并创建 MA Agent', 409);
    if (binding.pendingResource) throw new DomainError('上次 MA 操作结果未确认，请先核查后继续', 409);
    const hash = employeeConfigurationHash(employee);
    if (hash === binding.configurationHash) return this.view(id);
    const config = employeeAgentConfiguration(
      employee,
      await new MaSkills(new MaConfiguration(this.options.dataDir)).references(employee.skills),
    );
    const ark = this.ark();
    const agent = await ark.getAgent(binding.agentId);
    if (!agent.version || !/^\d+$/.test(agent.version)) throw new DomainError('MA Agent 版本不可确认', 502);
    // 更新请求一旦发出结果不明，不自动重试，以免重复发布版本。
    const before = this.get(id)!;
    before.pendingResource = 'agentSync';
    this.put(before);
    try {
      const result = await ark.updateAgent(binding.agentId, agent.version, config);
      const latest = this.get(id)!;
      latest.configurationHash = hash;
      latest.agentVersion = result.version;
      latest.syncedAt = new Date().toISOString();
      latest.pendingResource = undefined;
      this.put(latest);
      return this.view(id);
    } catch {
      throw new DomainError('MA 配置同步结果未确认，请核查远端版本；本地配置已保留', 502);
    }
  }
  async bindExisting(id: string, input: { appId?: unknown; appSecret?: unknown }) {
    this.employee(id);
    if (this.closed || this.initializationPaused) throw new DomainError('服务正在关闭或初始化', 503);
    const appId = typeof input.appId === 'string' ? input.appId.trim() : '';
    const appSecret = typeof input.appSecret === 'string' ? input.appSecret.trim() : '';
    if (
      !/^cli_[a-zA-Z0-9]{6,80}$/.test(appId) ||
      !appSecret ||
      appSecret.length > 512 ||
      /[\s\x00-\x1f]/.test(appSecret)
    )
      throw new DomainError('请填写有效的 App ID 和 App Secret');
    if (this.active.has(id) || this.running.has(id) || this.get(id)?.appId || this.get(id)?.pendingResource)
      throw new DomainError('该员工已绑定应用或正在接入，请使用现有接入状态继续处理', 409);
    if (this.importingApps.has(appId) || this.all().some((b) => b.appId === appId))
      throw new DomainError('此飞书应用已绑定其他数字员工或正在接入', 409);
    const controller = new AbortController();
    this.active.set(id, controller);
    this.importingApps.add(appId);
    try {
      const response = await (this.options.fetcher || fetch)(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
          redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new DomainError('无法验证飞书应用，请检查网络与应用凭证', 502);
      }
      const result = await response.json();
      if (result.code !== 0 || typeof result.tenant_access_token !== 'string' || !result.tenant_access_token)
        throw new DomainError('App ID 或 App Secret 验证失败，请确认是企业自建应用的有效凭证');
      if (this.closed || controller.signal.aborted) throw new DomainError('接入已取消', 409);
      this.employee(id);
      this.put({
        employeeId: id,
        appId,
        appSecret,
        permissionsVersion: 2,
        status: 'stopped',
        message: '已有应用凭证已验证，准备校验权限并连接',
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('验证飞书应用失败或超时，请检查凭证与网络后重试', 502);
    } finally {
      this.active.delete(id);
      this.importingApps.delete(appId);
    }
    return this.begin(id);
  }

  begin(id: string, confirmedNotCreated = false) {
    const employee = this.employee(id);
    if (this.closed || this.initializationPaused) throw new DomainError('服务正在关闭或初始化', 503);
    if (this.active.has(id) || this.running.has(id)) return this.view(id);
    let b = this.get(id);
    if (b?.pendingResource)
      throw new DomainError(`上次创建 ${b.pendingResource} 结果未确认，请先核查 MA 资源，避免重复创建`, 409);
    if (b && !b.appId && ['interrupted', 'error'].includes(b.status) && confirmedNotCreated !== true)
      throw new DomainError('上次应用创建结果未确认，请先在飞书开放平台核查；暂不自动重复创建', 409);
    b ||= { employeeId: id, status: 'creating' };
    b.status = b.appId ? 'provisioning' : 'creating';
    b.message = b.appId ? '准备运行环境' : '正在生成飞书创建确认链接';
    this.put(b);
    const controller = new AbortController();
    this.active.set(id, controller);
    const job = this.setup(b, employee.name, controller).finally(() => {
      this.active.delete(id);
      this.jobs.delete(job);
    });
    this.jobs.add(job);
    return this.view(id);
  }
  private async setup(b: Binding, name: string, controller: AbortController) {
    try {
      if (!b.appId) {
        const result = await (this.options.register || registerApp)({
          source: 'workforce-workforce',
          createOnly: true,
          signal: controller.signal,
          appPreset: { name, desc: '数字员工，提供飞书消息对话服务' },
          addons: {
            preset: false,
            scopes: {
              tenant: resolveLarkBotScopes(DEFAULT_LARK_DOMAINS),
              user: EMPLOYEE_CALENDAR_USER_SCOPES,
            },
            events: {
              items: {
                tenant: [
                  'im.message.receive_v1',
                  'im.chat.member.bot.added_v1',
                  'im.chat.member.bot.deleted_v1',
                ],
              },
            },
          },
          onQRCodeReady: (info) => {
            if (this.closed) return;
            const parsed = new URL(info.url);
            if (parsed.protocol !== 'https:') throw new Error('无效的飞书确认链接');
            Object.assign(b, {
              status: 'awaiting_confirmation',
              url: info.url,
              expiresAt: Date.now() + info.expireIn * 1000,
              message: '请使用当前飞书账号扫码确认创建；应用归属于实际确认的账号',
            });
            this.put(b);
          },
        });
        if (!result.client_id || !result.client_secret) throw new Error('应用创建结果不完整');
        Object.assign(b, {
          permissionsVersion: 2,
          appId: result.client_id,
          appSecret: result.client_secret,
          creatorId: result.user_info?.open_id,
          url: undefined,
          expiresAt: undefined,
          status: 'provisioning',
          message: '应用已绑定，准备 MA 运行环境',
        });
        this.put(b);
      }
      if (this.closed) return;
      await (this.options.provision || this.provision.bind(this))(b, () => this.put(b));
      if (this.closed) return;
      const stop = await (this.options.connect || this.connect.bind(this))(b);
      if (this.closed) {
        await stop();
        return;
      }
      this.running.set(b.employeeId, stop);
      Object.assign(b, { status: 'connected', message: 'Channel 已连接，可在飞书中向机器人发送消息' });
      this.put(b);
    } catch (error) {
      b.url = undefined;
      b.expiresAt = undefined;
      b.status =
        error instanceof MissingPermissions
          ? 'awaiting_permissions'
          : error instanceof MissingMaConfig
            ? 'awaiting_ma'
            : 'error';
      // SDK 错误可能含请求配置和密钥，因此不向页面或日志透传原始错误。
      b.message =
        error instanceof MissingMaConfig ||
        error instanceof MissingPermissions ||
        error instanceof DomainError
          ? error.message
          : b.pendingResource
            ? `创建 ${b.pendingResource} 结果未确认，请核查 MA 后继续`
            : b.appId
              ? '绑定已保留，启动失败。请检查 MA 配置、飞书应用发布状态和消息事件权限后重试'
              : '飞书创建未完成，请核查开放平台中的应用状态';
      this.put(b);
    }
  }
  private ark() {
    if (this.options.ark) return this.options.ark();
    const key = new MaConfiguration(this.options.dataDir).apiKey();
    if (!key?.trim())
      throw new MissingMaConfig('应用已绑定；请在页面右上角「方舟配置」中保存 API Key，然后继续接入');
    return new ArkClient(key.trim(), 'https://ark.cn-beijing.volces.com/api/v3');
  }
  private async provision(b: Binding, checkpoint: () => void) {
    if (b.permissionsVersion !== 2)
      throw new MissingPermissions('需要为现有应用补齐流式卡片、表情及原员工运行时权限');
    const client = new Client({
      appId: b.appId!,
      appSecret: b.appSecret!,
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
    });
    const grants = await client.application.scope.list({});
    if (grants.code || !grants.data?.scopes)
      throw new MissingPermissions('无法核查飞书应用权限，请检查应用发布状态');
    const tenant = new Set(
      grants.data.scopes
        .filter((s) => s.grant_status === 1 && s.scope_type === 'tenant')
        .map((s) => s.scope_name),
    );
    const missing = missingConversationScopes(tenant);
    b.groupEventsAuthorized = hasGroupEventScope(tenant);
    b.permissionWarnings = resolveLarkBotScopes(DEFAULT_LARK_DOMAINS).filter((scope) => !tenant.has(scope));
    checkpoint();
    if (missing.length)
      throw new MissingPermissions(
        `飞书应用尚缺权限：${missing.join('、')}。请在开放平台确认开通并发布后继续接入`,
      );
    const ark = this.ark();
    await this.memories?.migrate('employees', b.employeeId);
    const employee = this.employee(b.employeeId);
    const agentConfig = employeeAgentConfiguration(
      employee,
      await new MaSkills(new MaConfiguration(this.options.dataDir)).references(employee.skills),
    );
    const create = async (
      field: 'agentId' | 'environmentId' | 'vaultId',
      operation: () => Promise<string>,
    ) => {
      if (b[field]) return;
      b.pendingResource = field;
      checkpoint();
      b[field] = await operation();
      b.pendingResource = undefined;
      checkpoint();
    };
    const hadAgent = !!b.agentId;
    await create('agentId', async () => (await ark.createAgent(agentConfig)).id);
    if (hadAgent && (b.runtimeVersion !== 2 || b.configurationHash !== employeeConfigurationHash(employee))) {
      const agent = await ark.getAgent(b.agentId!);
      if (!agent.version || !/^\d+$/.test(agent.version)) throw new Error('MA Agent 版本不可确认');
      b.pendingResource = 'agentUpgrade';
      checkpoint();
      const updated = await ark.updateAgent(b.agentId!, agent.version, agentConfig);
      b.agentVersion = updated.version;
      b.pendingResource = undefined;
      checkpoint();
    }
    b.configurationHash = employeeConfigurationHash(employee);
    b.syncedAt = new Date().toISOString();
    checkpoint();
    const selectedEnvironment = employee.environment.maEnvironmentId;
    if (selectedEnvironment && this.environments) {
      await this.environments.validate(selectedEnvironment, b.appId);
      b.environmentId = selectedEnvironment;
      checkpoint();
    } else if (!b.environmentId && this.environments) {
      b.environmentId = await this.environments.ensureRecommended();
      checkpoint();
    }
    await create(
      'environmentId',
      async () => (await ark.createEnvironment(`workforce-${b.appId}`.slice(0, 60), b.appId!)).id,
    );
    await create('vaultId', () =>
      ark.createVault(`workforce-${b.appId}`, { workforce_employee: b.employeeId }),
    );
    if (!b.credentialId) {
      const credentials = await ark.listCredentials(b.vaultId!);
      const existing = credentials.find((item) => item.secretName === 'LARKSUITE_CLI_APP_SECRET');
      if (existing) b.credentialId = existing.id;
      else {
        b.pendingResource = 'botCredential';
        checkpoint();
        b.credentialId = await ark.createEnvironmentVariableCredential(
          b.vaultId!,
          'lark-cli-bot-app-secret',
          'LARKSUITE_CLI_APP_SECRET',
          b.appSecret!,
        );
        b.pendingResource = undefined;
      }
      checkpoint();
    }
    b.runtimeVersion = 2;
    checkpoint();
  }
  private async connect(b: Binding) {
    const ark = this.ark();
    const directory = resolve(this.options.dataDir, 'channels');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, createHash('sha256').update(b.appId!).digest('hex') + '.db');
    const store = new GatewayStore(path);
    chmodSync(path, 0o600);
    store.acquireRuntimeLock();
    const transport = createLarkChannel({
      appId: b.appId!,
      appSecret: b.appSecret!,
      transport: 'websocket',
      includeRawEvent: true,
      source: 'arkagent',
      handshakeTimeoutMs: 30000,
      httpTimeoutMs: 30000,
      keepalive: { enabled: true },
      policy: { dmMode: 'open', requireMention: false, respondToMentionAll: false },
      safety: { chatQueue: { enabled: false }, staleMessageWindowMs: 300000 },
    });
    registerGroupEvents(transport, b.appId!, (event) => {
      try {
        syncBotGroup(this.workspace, b.employeeId, event);
      } catch (error) {
        console.error('同步机器人群关系失败：', error);
      }
    });
    const channel = new LarkChannelAdapter({
      channel: transport,
      appId: b.appId!,
      appSecret: b.appSecret!,
      onSent: (message, id) => {
        store.recordOutgoing(message, id);
      },
    });
    const employeeEnabled = () => {
      const state = this.workspace.read().state;
      const employee = state.employees.find((e: any) => e.id === b.employeeId);
      return Boolean(employee?.enabled);
    };
    const memory = new SessionMemory(
      this.workspace,
      new MaMemoryApi(new MaConfiguration(this.options.dataDir)),
    );
    const { gateway, auth } = createEmployeeRuntime({
      store,
      ark,
      channel,
      config: {
        arkAgentId: b.agentId!,
        arkEnvironmentId: b.environmentId!,
        arkVaultId: b.vaultId!,
        feishuAppId: b.appId!,
        feishuAppSecret: b.appSecret!,
        sessionTimeoutMs: this.employee(b.employeeId).environment.timeout * 1000,
      },
      durableQueue: true,
      runtimeRevision: 'workforce-employee-ma-memory-v3',
      // 此请求构建只读取员工、项目记忆和环境配置，不创建外部资源。
      sessionRequestReadOnly: true,
      verifyQueuedMessages: true,
      buildSessionRequest: async (message, draft) => {
        const latest = this.get(b.employeeId)!;
        if (latest.configurationHash !== employeeConfigurationHash(this.employee(b.employeeId)))
          throw new DomainError('员工配置尚未同步 MA，请在工作台同步后继续');
        const selectedEnvironment =
          this.employee(b.employeeId).environment.maEnvironmentId || latest.environmentId;
        if (selectedEnvironment) {
          // Gateway 会重新读取所选环境，并重新注入当前员工的 Bot 身份与凭证边界。
          delete draft.environment;
          draft.environment_id = selectedEnvironment;
        }
        return memory.build(b.employeeId, message, draft);
      },
      // 初始化已写入长期 App Secret；lark-cli 自行获取短期 Bot Token。
      ensureBotToken: async () => {
        if (!b.credentialId) throw new Error('员工 Bot 凭证未准备完成');
      },
      businessHooks: {
        handleBusinessCommand: async (message) => {
          if (
            !this.organizer ||
            !/^(?:\/remember|整理近期会话|整理近期项目记忆)[。！!\s]*$/.test(message.text.trim())
          )
            return undefined;
          if (message.conversationType !== 'group') throw new DomainError('请在项目关联群中触发记忆整理');
          const group = this.workspace
            .read()
            .state.groups.find((g: any) => g.chatId === message.conversationId);
          const project = this.workspace.read().state.projects.find((p: any) => p.id === group?.projectId);
          if (!project?.memoryStores.length) throw new DomainError('请先关联项目并创建 MA 项目记忆库');
          const job = this.organizer.start(
            {
              requestId: 'feishu-memory:' + message.messageId,
              projectId: project.id,
              employeeId: b.employeeId,
              storeId: project.memoryStores[0].id,
            },
            message.senderId,
            message.conversationId,
          );
          return `已提交项目记忆整理任务：${job.id}。人的记忆保存到数字员工记忆，事情的记忆保存到项目库「${project.memoryStores[0].name}」。可在后台「运行中的任务」查看进度和结果。`;
        },
        afterBusinessTurn: async (message, failed) => {
          if (failed || !store.inbox.findMessage(message)?.replyConfirmed) return;
          const current = this.get(b.employeeId)!;
          current.lastRepliedAt = new Date().toISOString();
          this.put(current);
        },
        beforeBusinessTurn: async () => {
          if (!employeeEnabled()) throw new Error('员工已停用或删除');
        },
        validateBusinessSession: (message, sessionId) => memory.validate(b.employeeId, message, sessionId),
        observeBusinessResult: async (_message, sessionId, result) => {
          if (result.terminal === 'idle' && !result.authorizationRequired) memory.completed(sessionId);
        },
      },
    });
    try {
      await gateway.validateConfiguration();
      await startChannelAfterRecovery(
        channel,
        () => {
          auth.restore();
          gateway.recoverPendingMessages('lark', b.appId!);
        },
        (message) => {
          try {
            syncMessageGroup(this.workspace, b.employeeId, message);
          } catch (error) {
            console.error('同步群聊展示数据失败：', error);
          }
          if (!employeeEnabled()) return;
          if (gateway.accept(message)) {
            const current = this.get(b.employeeId)!;
            current.lastReceivedAt = new Date().toISOString();
            this.put(current);
          }
        },
      );
      // Gateway 没有 drain API；进程退出时由持久化队列恢复，不提前关闭其数据库。
      return async () => {
        auth.close();
        await channel.stop();
      };
    } catch (error) {
      auth.close();
      await channel.stop();
      store.close();
      throw error;
    }
  }
  resourceBindings() {
    return this.all();
  }
  saveResourceBinding(binding: Binding) {
    this.put(binding);
  }
  async pauseForInitialization() {
    if (this.closed) throw new DomainError('服务正在关闭', 503);
    if (this.active.size || this.synchronizing.size)
      throw new DomainError('员工接入或同步进行中，请稍后初始化', 409);
    for (const binding of this.all()) {
      if (!binding.appId) continue;
      const path = resolve(
        this.options.dataDir,
        'channels',
        createHash('sha256').update(binding.appId).digest('hex') + '.db',
      );
      if (!existsSync(path)) continue;
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        if (
          db
            .prepare("SELECT 1 FROM gateway_message_inbox WHERE state IN ('preparing','dispatched') LIMIT 1")
            .get()
        )
          throw new DomainError('仍有对话正在执行，请结束后初始化', 409);
      } finally {
        db.close();
      }
    }
    this.initializationPaused = true;
    const stops = [...this.running.values()];
    await Promise.all(stops.map((stop) => stop()));
    this.running.clear();
  }
  resumeAfterInitialization() {
    if (this.closed || !this.initializationPaused) return;
    this.initializationPaused = false;
    this.resume();
  }
  resume() {
    for (const b of this.all())
      if (b.appId && !b.pendingResource) {
        try {
          this.begin(b.employeeId);
        } catch {
          /* 已删除的员工不再启动。 */
        }
      }
  }
  async stop() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.jobs]);
    await Promise.allSettled([...this.running.values()].map((stop) => stop()));
  }
}
class MissingMaConfig extends Error {}
class MissingPermissions extends Error {}
