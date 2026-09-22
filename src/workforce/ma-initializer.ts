import { createHash, randomUUID } from 'node:crypto';
import { MaResourceRegistry } from './ma-resource-registry.ts';
export { MaResourceRegistry } from './ma-resource-registry.ts';
import { ensureTemplateSkills } from './template-skills.ts';
import { employeeTemplate, employeeTemplates, initializeEmployeeTemplate } from './employee-templates.ts';
import { ArkClient } from '../ark.ts';
import { DomainError } from './domain.ts';
import { MaMemoryApi } from './ma-memory.ts';
import { MaSkills } from './ma-skills.ts';
import { PLATFORM_SKILLS } from './skill-catalog.ts';
import { employeeAgentConfiguration, employeeConfigurationHash } from './agent-configuration.ts';
import { RECOMMENDED_ENVIRONMENT_NAME } from './ma-environments.ts';
import type { LocalWorkspace } from './workspace.ts';
import type { MaConfiguration } from './ma-config.ts';
import type { WorkspaceChannels } from './channels.ts';
import type { WorkspaceMemories } from './workspace-memories.ts';

export const ADA_SKILL_NAMES = ['ada-artist-profile', 'ada-brand-fit', 'ada-campaign-review'];

export class MaInitializer {
  running = false;
  private workspace: LocalWorkspace;
  private config: MaConfiguration;
  private channels: WorkspaceChannels;
  private memories: WorkspaceMemories;
  constructor(
    workspace: LocalWorkspace,
    config: MaConfiguration,
    channels: WorkspaceChannels,
    memories: WorkspaceMemories,
  ) {
    this.workspace = workspace;
    this.config = config;
    this.channels = channels;
    this.memories = memories;
    for (const task of workspace.tasks())
      if (task.type === 'ma_init' && task.status === 'running') {
        task.status = 'failed';
        task.progress = '服务重启，请重新核验资源';
        workspace.putTask(task);
      }
  }
  status() {
    return { running: this.running, task: this.workspace.tasks().find((t) => t.type === 'ma_init') || null };
  }
  async initializeTemplate(key: string) {
    const template = employeeTemplate(key);
    if (this.running) throw new DomainError('初始化正在进行，请稍后重试', 409);
    // 先检查重名，避免无效请求产生云端资源；不覆盖已有模板内容。
    const current = this.workspace.read();
    if (
      !current.state.employees.some((e: any) => e.templateId === template.templateId) &&
      current.state.employees.some((e: any) => e.name.trim().toLowerCase() === template.name.toLowerCase())
    )
      throw new DomainError('已存在同名员工，初始化不会覆盖已有配置', 409);
    if (!this.config.apiKey())
      return {
        ...initializeEmployeeTemplate(this.workspace, key),
        skillStatus: 'pending',
        message: '员工配置已保存；请先配置方舟 API Key，再次初始化以绑定真实 MA 技能。',
      };
    this.running = true;
    const job: any = {
      id: randomUUID(),
      requestId: randomUUID(),
      type: 'ma_init',
      name: `初始化${template.name}`,
      status: 'running',
      createdAt: new Date().toISOString(),
      progress: '核验 MA 技能',
      steps: [],
      warnings: [],
    };
    this.workspace.putTask(job);
    try {
      const skills = await ensureTemplateSkills(this.workspace, this.config, template.skills, (message) => {
        job.progress = message;
        job.steps.push(message);
        this.workspace.putTask(job);
      });
      const result = initializeEmployeeTemplate(this.workspace, key);
      const latest = this.workspace.read();
      const e = latest.state.employees.find((e: any) => e.id === result.employeeId);
      for (const skill of skills) {
        const index = e.skills.findIndex((s: any) => s.name === skill.name || s.id === skill.id);
        if (index < 0) e.skills.push(skill);
        else e.skills[index] = { ...skill, enabled: e.skills[index].enabled };
      }
      const saved = this.workspace.save(latest.state, latest.revision);
      job.status = 'completed';
      job.progress = '员工配置与 MA 技能已就绪，外部业务依赖仍需配置';
      return {
        ...saved,
        employeeId: result.employeeId,
        created: result.created,
        skillStatus: 'ready',
        message: job.progress,
      };
    } catch (error) {
      job.status = 'failed';
      job.progress = error instanceof DomainError ? error.message : '技能初始化失败，请查看 MA 资源后重试';
      throw new DomainError(job.progress, error instanceof DomainError ? error.status : 502);
    } finally {
      this.running = false;
      job.finishedAt = new Date().toISOString();
      this.workspace.putTask(job);
    }
  }
  start() {
    if (this.running) return this.status();
    const key = this.config.apiKey();
    if (!key) throw new DomainError('请先保存方舟 API Key');
    if (
      this.workspace
        .tasks()
        .some(
          (t) => ['memory', 'memory_schedule'].includes(t.type) && ['running', 'queued'].includes(t.status),
        )
    )
      throw new DomainError('请等待当前记忆整理任务结束后再初始化', 409);
    this.running = true;
    const job: any = {
      id: randomUUID(),
      requestId: randomUUID(),
      type: 'ma_init',
      name: '初始化 MA 配套资源',
      status: 'running',
      createdAt: new Date().toISOString(),
      progress: '验证当前账户',
      steps: [],
      warnings: [],
    };
    this.workspace.putTask(job);
    void this.run(key, job)
      .catch((error) => {
        job.status = 'failed';
        job.progress = error instanceof DomainError ? error.message : '初始化未完成，请核查 MA 资源后重试';
      })
      .finally(() => {
        this.running = false;
        job.finishedAt = new Date().toISOString();
        this.workspace.putTask(job);
      });
    return this.status();
  }
  private async run(key: string, job: any) {
    const guarded = {
      apiKey: () => {
        if (this.config.apiKey() !== key) throw new DomainError('API Key 已变化，停止初始化', 409);
        return key;
      },
    };
    const api = new MaMemoryApi(guarded),
      ark = new ArkClient(key, 'https://ark.cn-beijing.volces.com/api/v3');
    const availableEnvironments = await api.all('/environments');
    await this.channels.pauseForInitialization();
    job.warnings.push('初始化完成后自动恢复飞书连接，请在飞书发送 /new 使用新资源。');
    const registry = new MaResourceRegistry(
      this.workspace,
      createHash('sha256').update(key).digest('hex'),
      api,
    );
    const note = (text: string) => {
      job.progress = text;
      job.steps.push(text);
      this.workspace.putTask(job);
    };
    const needed = employeeTemplates.filter(
      (t) =>
        t.key === 'ada' ||
        this.workspace.read().state.employees.some((e: any) => e.templateId === t.templateId),
    );
    const skills = await ensureTemplateSkills(
      this.workspace,
      this.config,
      needed.flatMap((t) => t.skills),
      note,
    );
    let current = this.workspace.read();
    for (const e of current.state.employees) {
      e.skills = e.skills.map((old: any) => {
        const name = old.name || PLATFORM_SKILLS.find((s) => s.id === old.id)?.name;
        const replacement = skills.find((s) => s.name === name);
        return replacement ? { ...replacement, enabled: old.enabled } : old;
      });
      const template = employeeTemplates.find((t) => t.templateId === e.templateId);
      if (template && !e.skills.length)
        e.skills = skills.filter((s) => template.skills.some((spec) => spec.name === s.name));
    }
    this.workspace.save(current.state, current.revision, true);
    const knownEnv = this.workspace.db
      .prepare('SELECT remote_id FROM workspace_recommended_environment WHERE id=1')
      .get()?.remote_id;
    const env = await registry.ensure(
      'recommended-environment',
      '/environments',
      typeof knownEnv === 'string'
        ? knownEnv
        : availableEnvironments.find((e: any) => e.name === RECOMMENDED_ENVIRONMENT_NAME)?.id,
      () => ark.createEnvironment(RECOMMENDED_ENVIRONMENT_NAME, ''),
    );
    this.workspace.db
      .prepare('INSERT OR REPLACE INTO workspace_recommended_environment VALUES(1,?)')
      .run(env.resource.id);
    note(`${env.created ? '已创建' : '已复用'}推荐环境`);
    for (const kind of ['employees', 'projects'])
      for (const owner of this.workspace.read().state[kind]) {
        if (owner.memoryMode !== 'ma') await this.memories.migrate(kind, owner.id);
        for (const store of this.memories.owner(kind, owner.id).memoryStores) {
          const result = await registry.ensure(
            `memory:${kind}:${owner.id}:${store.id}`,
            '/memory_stores',
            store.maStoreId,
            () =>
              api.createStore(store.name, store.description || '', {
                workforce_owner: kind,
                workforce_owner_id: owner.id,
              }),
          );
          if (result.created)
            job.warnings.push(
              `${owner.name} / ${store.name}：已创建空库。旧 MA 正文未在本地备份，无法自动恢复。`,
            );
          current = this.workspace.read();
          const target = current.state[kind]
            .find((o: any) => o.id === owner.id)
            .memoryStores.find((s: any) => s.id === store.id);
          target.maStoreId = result.resource.id;
          target.memoryCount = result.created ? 0 : (result.resource.memory_count ?? target.memoryCount);
          this.workspace.save(current.state, current.revision, true);
          this.workspace.db
            .prepare('INSERT OR REPLACE INTO workspace_memory_links VALUES(?,?,?)')
            .run(JSON.stringify([kind, owner.id, store.id]), result.resource.id, randomUUID());
          note(`${result.created ? '已创建' : '已复用'}记忆库：${owner.name} / ${store.name}`);
        }
      }
    for (const employee of this.workspace.read().state.employees.filter((e: any) => e.enabled)) {
      const binding: any = this.channels.resourceBindings().find((b) => b.employeeId === employee.id) || {
        employeeId: employee.id,
      };
      if (
        binding.pendingResource &&
        ['agentSync', 'agentUpgrade'].includes(binding.pendingResource) &&
        binding.agentId
      ) {
        try {
          await api.call(`/agents/${encodeURIComponent(binding.agentId)}`);
        } catch (error) {
          if (!(error instanceof DomainError && error.status === 404)) throw error;
          binding.agentId = undefined;
          binding.pendingResource = undefined;
          this.channels.saveResourceBinding(binding);
        }
      }
      if (binding.pendingResource)
        throw new DomainError(`${employee.name} 存在未确认的资源操作，请先核查`, 409);
      let environmentId = employee.environment.maEnvironmentId || binding.environmentId || env.resource.id;
      try {
        await api.call(`/environments/${encodeURIComponent(environmentId)}`);
      } catch (error) {
        if (!(error instanceof DomainError && error.status === 404)) throw error;
        environmentId = env.resource.id;
      }
      current = this.workspace.read();
      const e = current.state.employees.find((e: any) => e.id === employee.id);
      e.environment.maEnvironmentId = environmentId;
      this.workspace.save(current.state, current.revision, true);
      const config = employeeAgentConfiguration(e, await new MaSkills(this.config).references(e.skills));
      const agent = await registry.ensure(`agent:${e.id}`, '/agents', binding.agentId, () =>
        ark.createAgent(config),
      );
      if (!agent.created && binding.configurationHash !== employeeConfigurationHash(e)) {
        binding.pendingResource = 'agentSync';
        this.channels.saveResourceBinding(binding);
        const updated = await ark.updateAgent(agent.resource.id, String(agent.resource.version), config);
        binding.agentVersion = updated.version;
        binding.pendingResource = undefined;
      }
      binding.agentId = agent.resource.id;
      binding.configurationHash = employeeConfigurationHash(e);
      binding.environmentId = environmentId;
      this.channels.saveResourceBinding(binding);
      const vault = await registry.ensure(`vault:${e.id}`, '/vaults', binding.vaultId, async () => ({
        id: await ark.createVault(`workforce-${e.id}`, { workforce_employee: e.id }),
      }));
      binding.vaultId = vault.resource.id;
      this.channels.saveResourceBinding(binding);
      if (binding.appId && binding.appSecret) {
        const found = (await ark.listCredentials(binding.vaultId)).find(
          (c) => c.secretName === 'LARKSUITE_CLI_APP_SECRET',
        );
        const credential = await registry.ensure(
          `credential:${e.id}:${binding.vaultId}`,
          `/vaults/${binding.vaultId}/credentials`,
          found?.id,
          async () => ({
            id: await ark.createEnvironmentVariableCredential(
              binding.vaultId,
              'lark-cli-bot-app-secret',
              'LARKSUITE_CLI_APP_SECRET',
              binding.appSecret,
            ),
          }),
        );
        binding.credentialId = credential.resource.id;
      }
      binding.status = 'stopped';
      binding.message = 'MA 资源初始化完成，准备恢复连接';
      binding.runtimeVersion = 2;
      this.channels.saveResourceBinding(binding);
      note(`已初始化数字员工：${employee.name}`);
    }
    if (this.channels.organizer) {
      await this.channels.organizer.initializeResource();
      note('已核验记忆整理 Agent');
    }
    this.channels.resumeAfterInitialization();
    job.status = 'completed';
    job.progress = 'MA 配套资源初始化完成，已发起飞书重连';
    job.result = [...job.steps, ...job.warnings].join('\n');
  }
}
