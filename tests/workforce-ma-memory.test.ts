import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LocalWorkspace } from '../src/workforce/workspace.ts';
import { MaMemoryApi } from '../src/workforce/ma-memory.ts';
import { WorkspaceMemories } from '../src/workforce/workspace-memories.ts';
import { SessionMemory, memoryScope } from '../src/workforce/session-memory.ts';
import { MemoryOrganizer } from '../src/workforce/memory-organizer.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const workspace = new LocalWorkspace(':memory:');
  const employee = {
    id: 'e',
    name: '助手',
    enabled: true,
    environment: { model: '待配置', timeout: 300 },
    skills: [],
    credentials: [],
    channels: { feishu: { enabled: false, appId: '' }, doubao: { enabled: false, agentId: '' } },
    versions: [],
    activeVersion: null,
    memoryStores: [{ id: 'es', name: '员工库' }],
    memories: [{ id: 'em', storeId: 'es', path: 'identity.md', content: '员工知识' }],
  };
  workspace.save(
    {
      employees: [employee],
      projects: [
        {
          id: 'p',
          name: '项目',
          memoryStores: [{ id: 'ps', name: '项目库' }],
          memories: [{ id: 'pm', storeId: 'ps', path: 'notes/brief.md', content: '原始项目背景' }],
          members: [{ id: 'u', name: '成员', account: 'ou_writer', permission: 'manage' }],
          groups: [],
        },
      ],
      groups: [{ id: 'g', chatId: 'oc_group', name: '群', projectId: 'p', employeeIds: ['e'] }],
    },
    0,
  );
  const stores = new Map<string, any>(),
    calls: any[] = [],
    sessions = new Map<string, any>();
  let sequence = 0,
    loseCreate = false;
  const fetcher = async (url: any, init: any) => {
    const path = new URL(url).pathname.replace('/api/v3', ''),
      method = init.method || 'GET',
      body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    const reply = (value: any, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/memory_stores' && method === 'POST') {
      const id = `memstore-${++sequence}`;
      const store = { ...body, id, type: 'memory_store', memory_count: 0, entries: new Map() };
      stores.set(id, store);
      if (loseCreate) {
        loseCreate = false;
        throw new Error('lost response');
      }
      return reply({ ...store, entries: undefined });
    }
    if (path === '/memory_stores')
      return reply({ data: [...stores.values()].map((s) => ({ ...s, entries: undefined })), next_page: '' });
    const match = path.match(/^\/memory_stores\/([^/]+)(?:\/memories(?:\/([^/]+))?)?$/);
    if (match) {
      const store = stores.get(match[1]);
      if (!store) return reply({}, 404);
      const id = match[2];
      if (!path.includes('/memories')) {
        if (method === 'POST') Object.assign(store, body);
        return reply({ ...store, memory_count: store.entries.size, entries: undefined });
      }
      if (id) {
        const entry = store.entries.get(id);
        if (!entry) return reply({}, 404);
        if (method === 'DELETE') {
          store.entries.delete(id);
          return reply({ deleted: true });
        }
        if (method === 'POST') {
          if (entry.path !== body.path) {
            store.entries.delete(id);
            entry.id = `mem-${++sequence}`;
            store.entries.set(entry.id, entry);
          }
          Object.assign(entry, body, {
            content_sha256: sha(body.content),
            updated_at: new Date().toISOString(),
          });
        }
        return reply(entry);
      }
      if (method === 'GET')
        return reply({
          data: [...store.entries.values()].map((e: any) => ({ ...e, content: undefined })),
          next_page: '',
        });
      if ([...store.entries.values()].some((e: any) => e.path === body.path)) return reply({}, 409);
      const entry = {
        ...body,
        id: `mem-${++sequence}`,
        type: 'memory',
        memory_store_id: store.id,
        content_sha256: sha(body.content),
        updated_at: new Date().toISOString(),
      };
      store.entries.set(entry.id, entry);
      return reply({ ...entry, content: undefined });
    }
    if (path === '/agents') return reply({ id: 'agent-organizer' });
    if (path === '/sessions' && method === 'POST') {
      sessions.set('sesn-organizer', { ...body, id: 'sesn-organizer', events: [] });
      return reply({ id: 'sesn-organizer' });
    }
    const sessionPath = path.match(/^\/sessions\/([^/]+)(\/events)?$/);
    if (sessionPath) {
      const session = sessions.get(sessionPath[1]);
      if (!session) return reply({}, 404);
      if (!sessionPath[2]) return reply(session);
      if (method === 'GET') return reply({ data: session.events, next_page: '' });
      session.events.push(...body.events.map((e: any) => ({ ...e, id: `evt-${++sequence}` })));
      if (body.events[0].type === 'user.message')
        session.events.push(
          {
            id: 'tool-read',
            type: 'agent.custom_tool_use',
            name: 'read_source_session',
            input: { sessionId: 'sesn-source' },
          },
          {
            id: 'idle-read',
            type: 'session.status_idle',
            stop_reason: { type: 'requires_action', event_ids: ['tool-read'] },
          },
        );
      else if (body.events[0].custom_tool_use_id === 'tool-read')
        session.events.push(
          {
            id: 'tool-write',
            type: 'agent.custom_tool_use',
            name: 'write_project_memory',
            input: {
              path: 'decisions/launch.md',
              content: '上线日期：10 月 15 日',
              sourceSessionIds: ['sesn-source'],
            },
          },
          {
            id: 'idle-write',
            type: 'session.status_idle',
            stop_reason: { type: 'requires_action', event_ids: ['tool-write'] },
          },
        );
      else
        session.events.push({ id: 'done', type: 'session.status_idle', stop_reason: { type: 'end_turn' } });
      return reply({});
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const api = new MaMemoryApi({ apiKey: () => 'test-key' }, fetcher as any);
  const memories = new WorkspaceMemories(workspace, api);
  return {
    workspace,
    api,
    memories,
    stores,
    calls,
    sessions,
    lose: () => {
      loseCreate = true;
    },
  };
}

test('迁移后所有正文在 MA，本地保存仅保留关联，重复迁移不重复创建', async () => {
  const f = fixture();
  try {
    await f.memories.migrate('projects', 'p');
    await f.memories.migrate('projects', 'p');
    const project = f.workspace.read().state.projects[0];
    assert.equal(project.memoryMode, 'ma');
    assert.deepEqual(project.memories, []);
    const list = await f.memories.list('projects', 'p', 'ps');
    assert.equal(list.entries[0].path, 'notes/brief.md');
    assert.equal(
      (await f.memories.detail('projects', 'p', 'ps', list.entries[0].id)).content,
      '原始项目背景',
    );
    assert.equal(f.calls.filter((c) => c.path === '/memory_stores' && c.method === 'POST').length, 1);
    const view = f.workspace.read();
    view.state.projects[0].memories = [{ content: '不能重新落本地' }];
    view.state.projects[0].memoryStores = [];
    f.workspace.save(view.state, view.revision);
    assert.equal(f.workspace.read().state.projects[0].memoryStores.length, 1);
    assert.deepEqual(f.workspace.read().state.projects[0].memories, []);
  } finally {
    f.workspace.close();
  }
});
test('Store 创建回包丢失后按 metadata 核查恢复，不丢失旧正文或重复创建', async () => {
  const f = fixture();
  try {
    f.lose();
    await assert.rejects(f.memories.migrate('projects', 'p'), /未确认/);
    assert.equal(f.workspace.read().state.projects[0].memories[0].content, '原始项目背景');
    await f.memories.migrate('projects', 'p');
    assert.equal(f.stores.size, 1);
    assert.deepEqual(f.workspace.read().state.projects[0].memories, []);
  } finally {
    f.workspace.close();
  }
});
test('MA 原位修改路径及正文，旧 SHA 阻止覆盖，不能越过记忆库归属', async () => {
  const f = fixture();
  try {
    await f.memories.migrate('projects', 'p');
    const list = await f.memories.list('projects', 'p', 'ps');
    const entry = await f.memories.detail('projects', 'p', 'ps', list.entries[0].id);
    const updated = await f.memories.saveEntry(
      'projects',
      'p',
      { storeId: 'ps', path: 'renamed.md', content: '新内容', sha: entry.sha },
      entry.id,
    );
    assert.notEqual(updated.id, entry.id);
    assert.equal(updated.path, 'renamed.md');
    assert.equal(updated.content, '新内容');
    await assert.rejects(
      f.memories.saveEntry(
        'projects',
        'p',
        { storeId: 'ps', path: 'x.md', content: '旧编辑', sha: entry.sha },
        updated.id,
      ),
      /已更新/,
    );
    await assert.rejects(f.memories.detail('employees', 'e', 'ps', entry.id), /迁移|未关联/);
    await f.memories.deleteEntry('projects', 'p', 'ps', updated.id, updated.sha);
    assert.equal((await f.memories.list('projects', 'p', 'ps')).entries.length, 0);
  } finally {
    f.workspace.close();
  }
});
test('Session 创建原生挂载去重，单聊只挂员工库，关联变化拒绝旧 Session', async () => {
  const f = fixture();
  try {
    await f.memories.migrate('employees', 'e');
    await f.memories.migrate('projects', 'p');
    const policy = new SessionMemory(f.workspace, f.api),
      message: any = { conversationType: 'group', conversationId: 'oc_group' };
    const request = policy.build('e', message, {
      agent: 'agent-e',
      resources: [{ type: 'file', file_id: 'f' }],
    });
    assert.equal(request.resources.filter((r) => r.type === 'memory_store').length, 2);
    assert.ok(
      request.resources.filter((r) => r.type === 'memory_store').every((r) => r.access === 'read_only'),
    );
    assert.equal(
      memoryScope(f.workspace.read().state, 'e', { conversationType: 'direct', conversationId: 'dm' })
        .storeIds.length,
      1,
    );
    f.sessions.set('sesn-test', { ...request, id: 'sesn-test' });
    await policy.validate('e', message, 'sesn-test');
    const current = f.workspace.read();
    current.state.groups[0].projectId = '';
    f.workspace.save(current.state, current.revision);
    await assert.rejects(policy.validate('e', message, 'sesn-test'), /旧项目上下文/);
  } finally {
    f.workspace.close();
  }
});
test('MA 分页按 next_page 拉全，重复游标失败', async () => {
  let reads = 0;
  const api = new MaMemoryApi({ apiKey: () => 'key' }, async (url: any) => {
    reads++;
    return new Response(
      JSON.stringify({ data: [{ id: reads }], next_page: String(url).includes('page=') ? '' : 'cursor' }),
    );
  });
  assert.equal((await api.entries('memstore-x')).length, 2);
  const broken = new MaMemoryApi(
    { apiKey: () => 'key' },
    async () => new Response(JSON.stringify({ data: [], next_page: 'same' })),
  );
  await assert.rejects(broken.entries('memstore-x'), /游标重复/);
});
test('整理 Agent 使用 MA Custom Tool 完成模拟写回链路，不要求项目成员权限但仍限制来源范围', async () => {
  const f = fixture();
  let organizer: MemoryOrganizer | undefined;
  try {
    await f.memories.migrate('employees', 'e');
    await f.memories.migrate('projects', 'p');
    const policy = new SessionMemory(f.workspace, f.api),
      message: any = { conversationType: 'group', conversationId: 'oc_group' };
    f.sessions.set('sesn-source', {
      ...policy.build('e', message, { agent: 'agent-e' }),
      id: 'sesn-source',
      events: [
        {
          id: 'source-user',
          type: 'user.message',
          content: [{ type: 'text', text: '确认上线日期为10月15日' }],
        },
      ],
    });
    await policy.validate('e', message, 'sesn-source');
    policy.completed('sesn-source');
    organizer = new MemoryOrganizer(f.memories, policy, () => ({
      agentId: 'agent-e',
      environmentId: 'env-e',
    }));
    const job = organizer.start(
      { requestId: 'good', projectId: 'p', employeeId: 'e', storeId: 'ps' },
      'ou_unlisted_user',
      'oc_group',
    );
    await assert.rejects(
      organizer.execute(job, { name: 'read_source_session', input: { sessionId: 'sesn-other' } }),
      /范围/,
    );
    for (let i = 0; i < 70 && ['queued', 'running'].includes(job.status); i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(job.status, 'completed');
    assert.equal(job.writes.length, 1);
    const saved = await f.memories.detail('projects', 'p', 'ps', job.writes[0].id);
    assert.ok(saved.content.includes('10 月 15 日'));
    assert.ok(saved.content.includes('sesn-source'));
    const remote = f.calls.find((c) => c.path === '/sessions' && c.method === 'POST');
    assert.deepEqual(remote.body.vault_ids, []);
    assert.equal(remote.body.resources[0].type, 'memory_store');
    assert.ok(f.calls.some((c) => c.body?.events?.[0]?.type === 'user.custom_tool_result'));
  } finally {
    await organizer?.stop();
    f.workspace.close();
  }
});

test('排队写入在调用 MA 前重新校验权限，撤权不产生写入', async () => {
  const f = fixture();
  try {
    await f.memories.migrate('projects', 'p');
    const before = f.calls.filter((c) => c.method === 'POST').length;
    await assert.rejects(
      f.memories.saveEntry(
        'projects',
        'p',
        { storeId: 'ps', path: 'blocked.md', content: '不应写入' },
        undefined,
        () => {
          throw new Error('权限已撤回');
        },
      ),
      /权限已撤回/,
    );
    assert.equal(f.calls.filter((c) => c.method === 'POST').length, before);
  } finally {
    f.workspace.close();
  }
});

test('切换 MA 环境后旧 Session 必须 /new，不继续沿用旧环境', async () => {
  const f = fixture();
  try {
    await f.memories.migrate('employees', 'e');
    const policy = new SessionMemory(f.workspace, f.api);
    const message: any = { conversationType: 'direct', conversationId: 'dm' };
    f.sessions.set('sesn-env', { ...policy.build('e', message, { agent: 'agent-e' }), id: 'sesn-env' });
    await policy.validate('e', message, 'sesn-env');
    const latest = f.workspace.read();
    latest.state.employees[0].environment.maEnvironmentId = 'env-selected';
    f.workspace.save(latest.state, latest.revision);
    await assert.rejects(policy.validate('e', message, 'sesn-env'), /new/);
  } finally {
    f.workspace.close();
  }
});

test('人物与事情写入不同 MA Store，人物按真实身份去重且不能冒用来源', async () => {
  const f = fixture();
  let organizer: MemoryOrganizer | undefined;
  try {
    await f.memories.migrate('employees', 'e');
    await f.memories.migrate('projects', 'p');
    organizer = new MemoryOrganizer(f.memories, new SessionMemory(f.workspace, f.api), () => ({
      agentId: 'a',
      environmentId: 'env',
    }));
    const job: any = {
      id: 'split',
      requestId: 'split-request',
      employeeId: 'e',
      projectId: 'p',
      storeId: 'ps',
      employeeStoreId: 'es',
      actorId: 'local-admin',
      sources: [{ id: 'sesn-person', employeeId: 'e', projectId: 'p', chatId: 'oc_group', direct: false }],
      readSessionIds: [],
      peopleEvidence: [],
      writes: [],
    };
    f.sessions.set('sesn-person', {
      events: [
        {
          id: 'person-event',
          type: 'user.message',
          content: [
            {
              type: 'text',
              text: '<current_actor open_id="ou_person" />\n\n<current_message message_id="m" chat_id="oc_group" />\n\n<current_request>我是小王，负责内容，偏好先看结论。确认项目10月15日发布。</current_request>',
            },
          ],
        },
      ],
    });
    const source = await organizer.execute(job, {
      name: 'read_source_session',
      input: { sessionId: 'sesn-person' },
    });
    assert.equal(source.interlocutors[0].openId, 'ou_person');
    const input = {
      openId: 'ou_person',
      name: '小王',
      role: '内容负责人',
      traits: ['偏好先看结论'],
      sourceSessionIds: ['sesn-person'],
      sourceEventIds: ['person-event'],
    };
    const person = await organizer.execute(job, { id: 'write-person', name: 'write_person_memory', input });
    assert.equal(person.category, 'people');
    assert.equal(person.storeId, 'es');
    assert.match((await f.memories.detail('employees', 'e', 'es', person.id)).content, /小王/);
    assert.ok(
      !(await f.memories.list('projects', 'p', 'ps')).entries.some((e) => e.path.startsWith('people/')),
    );
    const repeated = await organizer.execute(job, { id: 'write-person', name: 'write_person_memory', input });
    assert.equal(repeated.id, person.id);
    assert.equal(job.writes.length, 1);
    await assert.rejects(
      organizer.execute(job, {
        id: 'fake',
        name: 'write_person_memory',
        input: { ...input, openId: 'ou_mentioned' },
      }),
      /真实群发言者/,
    );
    await assert.rejects(
      organizer.execute(job, {
        id: 'wrong-store',
        name: 'write_project_memory',
        input: { path: 'people/ou_person.md', content: '人物画像', sourceSessionIds: ['sesn-person'] },
      }),
      /员工 Memory/,
    );
    const event = await organizer.execute(job, {
      id: 'write-event',
      name: 'write_project_memory',
      input: {
        path: 'decisions/launch.md',
        content: '项目于10月15日发布',
        sourceSessionIds: ['sesn-person'],
      },
    });
    assert.equal(event.category, 'events');
    assert.equal(event.storeId, 'ps');
    assert.match((await f.memories.detail('projects', 'p', 'ps', event.id)).content, /10月15日/);
    const updated = await organizer.execute(job, {
      id: 'update-person',
      name: 'write_person_memory',
      input: { ...input, id: person.id, sha: person.sha, traits: ['偏好先看结论', '要求标注来源'] },
    });
    assert.equal(updated.path, 'people/ou_person.md');
    assert.equal(
      (await f.memories.list('employees', 'e', 'es')).entries.filter((e) => e.path.startsWith('people/'))
        .length,
      1,
    );
  } finally {
    await organizer?.stop();
    f.workspace.close();
  }
});

test('已有整理 Agent 原位升级为七个分流工具，升级回包不确定后可识别远端配置', async () => {
  const f = fixture();
  let organizer: MemoryOrganizer | undefined;
  try {
    const calls: any[] = [];
    let remote: any = { id: 'agent-old', version: '1', metadata: {} };
    f.memories.api = new MaMemoryApi({ apiKey: () => 'key' }, async (_url: any, init: any) => {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        calls.push(body);
        remote = { id: 'agent-old', version: '2', ...body };
      }
      return new Response(JSON.stringify(remote));
    });
    organizer = new MemoryOrganizer(f.memories, new SessionMemory(f.workspace, f.api), () => ({
      agentId: 'a',
      environmentId: 'env',
    }));
    f.workspace.db
      .prepare('INSERT INTO workspace_memory_agent (id,remote_id,token,config_version) VALUES (1,?,?,1)')
      .run('agent-old', 'token');
    assert.equal(await (organizer as any).ensureAgent(), 'agent-old');
    assert.equal(calls[0].version, 1);
    assert.equal(calls[0].tools.length, 7);
    assert.ok(calls[0].tools.some((t: any) => t.name === 'write_person_memory'));
    f.workspace.db.prepare('UPDATE workspace_memory_agent SET config_version=1 WHERE id=1').run();
    await (organizer as any).ensureAgent();
    assert.equal(calls.length, 1);
  } finally {
    await organizer?.stop();
    f.workspace.close();
  }
});

test('旧社媒 JSON 契约迁移为 Markdown 路径且保留正文和自定义知识', async () => {
  const f = fixture();
  try {
    const state = f.workspace.read();
    const e = state.state.employees[0];
    e.templateId = 'social-trends-weekly-v1';
    e.knowledge = '自定义知识；读取 config/dependencies.json';
    e.memories[0].path = 'config/dependencies.json';
    const original = e.memories[0].content;
    f.workspace.save(state.state, state.revision);
    await f.memories.migrate('employees', 'e');
    const saved = f.workspace.read().state.employees[0];
    assert.equal(saved.memoryMode, 'ma');
    assert.equal(saved.knowledge, '自定义知识；读取 config/dependencies.md');
    const written = f.calls.find((c: any) => c.method === 'POST' && c.body?.path);
    assert.equal(written.body.path, '/config/dependencies.md');
    assert.equal(written.body.content, original);
  } finally {
    f.workspace.close();
  }
});

test('不受支持的记忆后缀在发请求前被拒绝', () => {
  let requests = 0;
  const api = new MaMemoryApi({ apiKey: () => 'test' }, (async () => {
    requests++;
    return Response.json({});
  }) as any);
  assert.throws(() => api.createEntry('memstore-test', '/config.json', '{}'), /仅支持/);
  assert.equal(requests, 0);
});
