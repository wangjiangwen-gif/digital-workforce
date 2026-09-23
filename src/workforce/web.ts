import type { MaInitializer } from './ma-initializer.ts';
import type { MaEnvironments } from './ma-environments.ts';
import type { MemoryOrganizer } from './memory-organizer.ts';
import type { WorkspaceMemories } from './workspace-memories.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Workforce, DomainError, type Principal, type Job, type Memory, type Turn } from './domain.ts';
import { LocalLab } from './lab.ts';
import { LocalWorkspace, normalizeGroups } from './workspace.ts';
import type { WorkspaceChannels } from './channels.ts';
import type { MaConfiguration } from './ma-config.ts';
import type { FeishuGroups } from './feishu-groups.ts';
import { employeeTemplates, initializeEmployeeTemplate } from './employee-templates.ts';
import { MaSkills } from './ma-skills.ts';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
type Access = { id: string; principal: Principal; active: boolean; expiresAt?: number };
export function saveAccessToken(w: Workforce, principal: Principal, token: string, expiresAt?: number) {
  if (token.length < 32) throw new Error('管理令牌至少32字符');
  w.put('access', {
    id: digest(token),
    principal,
    active: true,
    ...(expiresAt ? { expiresAt } : {}),
  } as Access);
}
function authenticate(w: Workforce, req: IncomingMessage): Principal | undefined {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const cookie = req.headers.cookie
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('wf_session='))
    ?.slice(11);
  const token = bearer || cookie;
  if (!token) return;
  const entry = w.get<Access>('access', digest(token));
  if (entry?.active && (!entry.expiresAt || entry.expiresAt > Date.now())) return entry.principal;
}
async function body(req: IncomingMessage, limit = 160000) {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new DomainError('必须使用 application/json', 415);
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > limit) throw new DomainError('请求过大', 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError('JSON 无效');
  }
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
export async function createWeb(
  w: Workforce,
  options: {
    port: number;
    publicOrigin?: string;
    initializer?: MaInitializer;
    publicDir?: string;
    extractorMode?: string;
    workspace?: LocalWorkspace;
    channels?: WorkspaceChannels;
    maConfig?: MaConfiguration;
    feishuGroups?: FeishuGroups;
    memories?: WorkspaceMemories;
    organizer?: MemoryOrganizer;
    environments?: MaEnvironments;
  },
) {
  let publicOrigin: URL | undefined;
  if (options.publicOrigin) {
    try {
      publicOrigin = new URL(options.publicOrigin);
      if (
        publicOrigin.protocol !== 'https:' ||
        publicOrigin.username ||
        publicOrigin.password ||
        publicOrigin.pathname !== '/' ||
        publicOrigin.search ||
        publicOrigin.hash
      )
        throw new Error('invalid origin');
    } catch {
      throw new Error('WORKFORCE_PUBLIC_ORIGIN 必须为不含路径和凭证的 HTTPS Origin');
    }
  }
  const lab = new LocalLab(w);
  const publicDir = options.publicDir || resolve('public');
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const host = req.headers.host || '';
      const publicRequest = publicOrigin?.host === host;
      if (!publicRequest && !/^127\.0\.0\.1:\d+$/.test(host))
        throw new DomainError('只允许本机或已配置域名访问', 403);
      const origin = publicRequest ? publicOrigin!.origin : `http://${host}`;
      if (req.headers.origin && req.headers.origin !== origin) throw new DomainError('拒绝跨站请求', 403);
      const url = new URL(req.url || '/', origin);
      const path = url.pathname;
      const method = req.method || 'GET';
      if (options.workspace && path.startsWith('/api/workspace')) {
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new DomainError('拒绝跨站请求', 403);
        const workspace = options.workspace;
        if (path === '/api/workspace/ma-config/initialize' && options.initializer) {
          if (method === 'GET') return json(res, options.initializer.status());
          if (method === 'POST') {
            await body(req);
            return json(res, options.initializer.start(), 202);
          }
        }
        if (options.initializer?.running && method !== 'GET')
          throw new DomainError('MA 资源初始化进行中，请稍后修改配置', 409);

        const environmentRoute = path.match(/^\/api\/workspace\/employees\/([^/]+)\/environment$/);
        if (environmentRoute && options.environments) {
          const id = decodeURIComponent(environmentRoute[1]);
          const snapshot = workspace.read();
          const employee = snapshot.state.employees.find((e: any) => e.id === id);
          if (!employee) throw new DomainError('数字员工不存在', 404);
          const binding = options.channels?.view(id);
          if (method === 'GET') {
            const list = await options.environments.list(binding?.appId);
            return json(res, {
              ...list,
              selectedId:
                employee.environment.maEnvironmentId || binding?.environmentId || list.recommendedId,
            });
          }
          if (method === 'POST') {
            const input = await body(req);
            await options.environments.validate(input.maEnvironmentId, binding?.appId);
            const latest = workspace.read();
            if (input.revision !== latest.revision) throw new DomainError('配置已变化，请刷新后重试', 409);
            const current = latest.state.employees.find((e: any) => e.id === id);
            current.environment = {
              maEnvironmentId: input.maEnvironmentId,
              model: input.model,
              timeout: Number(input.timeout),
            };
            return json(res, workspace.save(latest.state, latest.revision));
          }
        }
        if (
          path === '/api/workspace/ma-environments/recommended' &&
          options.environments &&
          method === 'POST'
        ) {
          await body(req);
          return json(res, { id: await options.environments.ensureRecommended() });
        }
        const organize = path.match(/^\/api\/workspace\/projects\/([^/]+)\/organize-memory$/);
        if (organize && options.organizer && method === 'POST') {
          const input = await body(req);
          return json(
            res,
            options.organizer.start({ ...input, projectId: decodeURIComponent(organize[1]) }),
            202,
          );
        }
        const memoryOwner = path.match(
          /^\/api\/workspace\/(employees|projects)\/([^/]+)\/memory(?:\/(migrate|stores|entries)(?:\/([^/]+))?)?$/,
        );
        if (memoryOwner && options.memories) {
          const [, kind, encodedId, resource, encodedEntry] = memoryOwner;
          const id = decodeURIComponent(encodedId),
            entryId = encodedEntry ? decodeURIComponent(encodedEntry) : undefined;
          const storeId = url.searchParams.get('storeId') || '';
          if (!resource && method === 'GET')
            return json(res, await options.memories.list(kind, id, storeId || undefined));
          if (resource === 'migrate' && method === 'POST') {
            await body(req);
            return json(res, await options.memories.migrate(kind, id));
          }
          if (resource === 'stores' && method === 'POST')
            return json(res, await options.memories.saveStore(kind, id, await body(req), entryId));
          if (resource === 'stores' && method === 'DELETE' && entryId) {
            await body(req);
            return json(res, await options.memories.deleteStore(kind, id, entryId));
          }
          if (resource === 'entries' && method === 'GET' && entryId)
            return json(res, await options.memories.detail(kind, id, storeId, entryId));
          if (resource === 'entries' && method === 'POST')
            return json(
              res,
              await options.memories.saveEntry(kind, id, await body(req, 256 * 1024), entryId),
            );
          if (resource === 'entries' && method === 'DELETE' && entryId) {
            const input = await body(req);
            return json(res, await options.memories.deleteEntry(kind, id, input.storeId, entryId, input.sha));
          }
          throw new DomainError('记忆操作不存在', 404);
        }
        if (path === '/api/workspace/ma-skills' && options.maConfig && method === 'GET')
          return json(res, await new MaSkills(options.maConfig).list());
        const skillBinding = path.match(/^\/api\/workspace\/employees\/([^/]+)\/skills$/);
        if (skillBinding && options.maConfig && method === 'POST') {
          const input = await body(req);
          if (typeof input.skillId !== 'string') throw new DomainError('请选择 MA Skill');
          return json(
            res,
            await new MaSkills(options.maConfig).bind(
              workspace,
              decodeURIComponent(skillBinding[1]),
              input.skillId,
            ),
          );
        }
        if (path === '/api/workspace/employee-templates' && method === 'GET')
          return json(res, { templates: employeeTemplates.map(({ create, ...template }) => template) });
        const templateInit = path.match(/^\/api\/workspace\/employee-templates\/([a-z-]+)\/initialize$/);
        if (templateInit && method === 'POST') {
          await body(req);
          return json(
            res,
            options.initializer
              ? await options.initializer.initializeTemplate(templateInit[1])
              : {
                  ...initializeEmployeeTemplate(workspace, templateInit[1]),
                  skillStatus: 'pending',
                  message: '配置已创建，MA 技能待初始化',
                },
          );
        }
        if (path === '/api/workspace/feishu-groups' && options.feishuGroups) {
          if (method === 'GET')
            return json(res, await options.feishuGroups.list(url.searchParams.get('pageToken') || ''));
          if (method === 'POST') {
            const input = await body(req);
            if (typeof input.chatId !== 'string') throw new DomainError('请选择飞书群聊');
            if (typeof input.projectId !== 'string' || !input.projectId) throw new DomainError('请选择项目');
            if (input.mode === 'manual')
              return json(res, options.feishuGroups.importManual(input.chatId, input.projectId));
            if (input.mode !== undefined) throw new DomainError('不支持的群聊关联方式');
            return json(res, await options.feishuGroups.import(input.chatId, input.projectId));
          }
        }
        const groupMembers = path.match(/^\/api\/workspace\/groups\/([^/]+)\/members$/);
        if (groupMembers && options.feishuGroups && method === 'GET')
          return json(
            res,
            await options.feishuGroups.members(
              decodeURIComponent(groupMembers[1]),
              url.searchParams.get('pageToken') || '',
            ),
          );
        if (path === '/api/workspace/feishu-groups/employees')
          throw new DomainError('请在飞书中添加或移除机器人，工作台仅同步展示', 405);
        const projectInvite = path.match(/^\/api\/workspace\/projects\/([^/]+)\/groups\/([^/]+)\/employees$/);
        if (projectInvite && options.feishuGroups) {
          const projectId = decodeURIComponent(projectInvite[1]);
          const groupId = decodeURIComponent(projectInvite[2]);
          options.feishuGroups.projectGroup(projectId, groupId);
          if (method === 'GET') return json(res, { employees: options.feishuGroups.employees() });
          if (method === 'POST') {
            const input = await body(req);
            if (typeof input.employeeId !== 'string') throw new DomainError('请选择数字员工');
            return json(res, await options.feishuGroups.invite(projectId, groupId, input.employeeId));
          }
        }
        const unlinkGroup = path.match(/^\/api\/workspace\/projects\/([^/]+)\/groups\/([^/]+)$/);
        if (unlinkGroup && method === 'DELETE') {
          await body(req);
          const current = workspace.read();
          const group = current.state.groups.find(
            (g: any) =>
              g.id === decodeURIComponent(unlinkGroup[2]) &&
              g.projectId === decodeURIComponent(unlinkGroup[1]),
          );
          if (!group) throw new DomainError('项目群聊不存在', 404);
          group.projectId = '';
          return json(res, workspace.save(current.state, current.revision));
        }
        if (path === '/api/workspace/ma-config' && options.maConfig) {
          if (method === 'GET') return json(res, options.maConfig.status());
          if (method === 'PUT') {
            const input = await body(req, 8192);
            options.maConfig.save(input?.apiKey);
            return json(res, await options.maConfig.verify());
          }
        }
        if (path === '/api/workspace/ma-config/verify' && options.maConfig && method === 'POST') {
          await body(req);
          return json(res, await options.maConfig.verify());
        }
        const syncAgent = path.match(/^\/api\/workspace\/employees\/([^/]+)\/sync-ma$/);
        if (syncAgent && options.channels && method === 'POST') {
          await body(req);
          return json(res, await options.channels.syncAgent(decodeURIComponent(syncAgent[1])));
        }
        const upgrade = path.match(/^\/api\/workspace\/employees\/([^/]+)\/feishu\/upgrade$/);
        if (upgrade && options.channels && method === 'POST') {
          await body(req);
          return json(res, options.channels.upgradePermissions(decodeURIComponent(upgrade[1])), 202);
        }
        const channel = path.match(/^\/api\/workspace\/employees\/([^/]+)\/feishu$/);
        if (channel && options.channels) {
          if (method === 'GET') return json(res, options.channels.view(decodeURIComponent(channel[1])));
          if (method === 'POST') {
            const input = await body(req);
            if (input?.mode !== undefined && !['existing', 'new'].includes(input.mode))
              throw new DomainError('不支持的飞书接入方式');
            return json(
              res,
              input?.mode === 'existing'
                ? await options.channels.bindExisting(decodeURIComponent(channel[1]), input)
                : options.channels.begin(decodeURIComponent(channel[1]), input?.confirmedNotCreated === true),
              202,
            );
          }
        }
        if (path === '/api/workspace' && method === 'GET') return json(res, workspace.read());
        if (path === '/api/workspace' && method === 'PUT') {
          const input = await body(req, 4 * 1024 * 1024);
          const current = workspace.read();
          if (input?.revision !== current.revision)
            throw new DomainError('数据已被其他页面修改，请刷新后重试', 409);
          if (!input?.state || !Array.isArray(input.state.projects)) throw new DomainError('工作台格式无效');
          const normalized = normalizeGroups(structuredClone(input.state));
          if (JSON.stringify(normalized.groups || []) !== JSON.stringify(current.state.groups))
            throw new DomainError('群聊关系只能通过飞书查询关联或机器人事件更新', 403);
          return json(res, workspace.save(input?.state, input?.revision));
        }
        if (path === '/api/workspace/tasks' && method === 'GET')
          return json(res, { tasks: workspace.tasks() });
        if (path === '/api/workspace/tasks' && method === 'POST')
          return json(res, workspace.enqueue(await body(req)), 201);
        const cancel = path.match(/^\/api\/workspace\/tasks\/([^/]+)\/cancel$/);
        if (cancel && method === 'POST') {
          await body(req);
          return json(res, workspace.cancel(cancel[1]));
        }
        throw new DomainError('工作台接口不存在', 404);
      }
      if (path === '/api/login' && method === 'POST') {
        const input = await body(req);
        if (typeof input?.token !== 'string') throw new DomainError('令牌无效', 401);
        const principal = authenticate(w, {
          headers: { authorization: `Bearer ${input.token}` },
        } as IncomingMessage);
        if (!principal) throw new DomainError('令牌无效或已过期', 401);
        const session = randomBytes(32).toString('hex');
        saveAccessToken(w, principal, session, Date.now() + 8 * 3600000);
        res.setHeader(
          'Set-Cookie',
          `wf_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        return json(res, { principal });
      }
      if (path.startsWith('/api/')) {
        const actor = authenticate(w, req);
        if (!actor) throw new DomainError('请先使用本机访问令牌登录', 401);
        if (path === '/api/logout' && method === 'POST') {
          const token = req.headers.cookie
            ?.split(';')
            .map((x) => x.trim())
            .find((x) => x.startsWith('wf_session='))
            ?.slice(11);
          if (token) {
            const access = w.get<Access>('access', digest(token));
            if (access) {
              access.active = false;
              w.put('access', access);
            }
          }
          res.setHeader('Set-Cookie', 'wf_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return json(res, { ok: true });
        }
        if (path === '/api/state' && method === 'GET')
          return json(res, {
            ...w.view(actor),
            upgrades: actor.role === 'admin' ? w.all('upgrade') : [],
            runtimes: actor.role === 'admin' ? w.all('runtime') : [],
            mode: 'local-management',
            extractor: options.extractorMode || 'explicit-confirmation',
          });
        if (path === '/api/employees' && method === 'POST')
          return json(res, w.createEmployee(actor, await body(req)), 201);
        const employee = path.match(/^\/api\/employees\/([^/]+)\/(draft|publish|activate)$/);
        if (employee && method === 'POST') {
          const input = await body(req);
          if (employee[2] === 'draft')
            return json(res, w.saveDraft(actor, employee[1], input.content, input.revision));
          if (employee[2] === 'publish') return json(res, w.publish(actor, employee[1], input.revision));
          return json(res, w.activate(actor, employee[1], input.releaseId));
        }
        if (path === '/api/projects' && method === 'POST')
          return json(res, w.createProject(actor, await body(req)), 201);
        const project = path.match(/^\/api\/projects\/([^/]+)$/);
        if (project && method === 'POST')
          return json(res, w.updateProject(actor, project[1], await body(req)));
        if (path === '/api/bindings' && method === 'POST') return json(res, w.bind(actor, await body(req)));
        const sources = path.match(/^\/api\/memories\/([^/]+)\/sources$/);
        if (sources && method === 'GET') {
          const m = w.get<Memory>('memory', sources[1]);
          if (!m) throw new DomainError('记忆不存在', 404);
          w.manage(actor, m.projectId);
          return json(
            res,
            m.sourceIds
              .map((id) => w.get<Turn>('turn', id))
              .filter((t) => t && !t.direct && t.projectId === m.projectId)
              .map((t) => ({
                id: t!.id,
                chatId: t!.chatId,
                threadId: t!.threadId,
                userId: t!.userId,
                messageId: t!.messageId,
                sessionId: t!.sessionId,
                text: t!.text,
              })),
          );
        }
        const memory = path.match(/^\/api\/memories\/([^/]+)\/(correct|delete|resolve|approve)$/);
        if (memory && method === 'POST')
          return json(res, w.editMemory(actor, memory[1], memory[2], await body(req)));
        if (path === '/api/resources' && method === 'POST')
          return json(res, w.registerResource(actor, await body(req)), 201);
        const resource = path.match(/^\/api\/resources\/([^/]+)\/revoke$/);
        if (resource && method === 'POST') {
          w.revokeResource(actor, resource[1]);
          return json(res, { ok: true });
        }
        if (path === '/api/lab/chat' && method === 'POST')
          return json(res, await lab.chat(actor, await body(req)));
        const job = path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
        if (job && method === 'POST') {
          const j = w.get<Job>('job', job[1]);
          if (!j) throw new DomainError('任务不存在', 404);
          w.manage(actor, j.projectId);
          if (j.state !== 'failed' || !w.jobAllowed(j)) throw new DomainError('只可重试权限仍有效的失败任务');
          j.state = 'scheduled';
          j.retries = 0;
          j.dueAt = Date.now() + 30000;
          w.put('job', j);
          w.audit(actor.id, 'job.retry', j.id);
          return json(res, j);
        }
        throw new DomainError('接口不存在', 404);
      }
      if (method !== 'GET') throw new DomainError('方法不支持', 405);
      const asset = (
        {
          '/': ['index.html', 'text/html'],
          '/app.js': ['app.js', 'text/javascript'],
          '/style.css': ['style.css', 'text/css'],
        } as Record<string, string[]>
      )[path];
      if (!asset) throw new DomainError('页面不存在', 404);
      const data = await readFile(resolve(publicDir, asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch (error) {
      json(
        res,
        { error: error instanceof DomainError ? error.message : '操作失败，请检查本机服务状态' },
        error instanceof DomainError ? error.status : 500,
      );
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('close', () => lab.close());
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : options.port}`,
  };
}
