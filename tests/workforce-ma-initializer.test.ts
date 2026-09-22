import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MaInitializer, MaResourceRegistry, ADA_SKILL_NAMES } from '../src/workforce/ma-initializer.ts';
import { MaConfiguration } from '../src/workforce/ma-config.ts';
import { DomainError } from '../src/workforce/domain.ts';
import { createSocialEmployee, SOCIAL_SKILL_NAMES } from '../src/workforce/social-template.ts';
import { createAdaEmployee } from '../src/workforce/employee-templates.ts';
import { PLATFORM_SKILLS } from '../src/workforce/skill-catalog.ts';

test('资源存在时复用；404 重建；其他状态不创建；超时不重复提交', async () => {
  const db = new DatabaseSync(':memory:');
  let status = 200,
    creates = 0;
  const api: any = {
    call: async (path: string) => {
      if (status !== 200) throw new DomainError('remote', status);
      return { id: path.split('/').at(-1) };
    },
  };
  const registry = new MaResourceRegistry({ db } as any, 'key', api);
  const create = async () => {
    creates++;
    return { id: 'new' };
  };
  try {
    assert.equal((await registry.ensure('one', '/skills', 'old', create)).created, false);
    assert.equal(creates, 0);
    status = 403;
    await assert.rejects(registry.ensure('one', '/skills', 'old', create));
    assert.equal(creates, 0);
    status = 404;
    assert.equal((await registry.ensure('one', '/skills', 'old', create)).resource.id, 'new');
    assert.equal(creates, 1);
    await assert.rejects(
      registry.ensure('timeout', '/skills', undefined, async () => {
        creates++;
        throw Error('timeout');
      }),
    );
    await assert.rejects(registry.ensure('timeout', '/skills', undefined, create), /未确认/);
    assert.equal(creates, 2);
    status = 200;
    assert.equal((await registry.ensure('one', '/skills', 'old', create)).resource.id, 'new');
  } finally {
    db.close();
  }
});
test('Skill 清单按 Key 保存，切换账户不串用初始化 ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-catalog-'));
  try {
    const config = new MaConfiguration(dir, {});
    config.save('first');
    config.savePlatformSkills([{ id: 'skill-first', tags: ['ada'] }]);
    config.save('second');
    assert.equal(config.platformSkills(), undefined);
    config.savePlatformSkills([{ id: 'skill-second', tags: ['ada'] }]);
    config.save('first');
    assert.equal(config.platformSkills()?.[0].id, 'skill-first');
    assert.ok(!JSON.stringify(config.status()).includes('first'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
for (const includeSocial of [false, true])
  test(`初始化先回读真实 Skill 再创建 Agent；双场景：${includeSocial}`, async (t) => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE workspace_recommended_environment(id INTEGER PRIMARY KEY,remote_id TEXT);CREATE TABLE workspace_memory_links(key TEXT PRIMARY KEY,remote_id TEXT,token TEXT);',
    );
    const employee = createAdaEmployee();
    employee.memoryStores = [];
    employee.memories = [];
    employee.memoryMode = 'ma';
    const social: any = createSocialEmployee();
    social.memoryStores = [];
    social.memories = [];
    social.memoryMode = 'ma';
    let state: any = { employees: includeSocial ? [employee, social] : [employee], projects: [], groups: [] },
      catalog: any;
    const tasks = new Map<string, any>(),
      calls: string[] = [];
    let binding: any;
    const workspace: any = {
      db,
      read: () => ({ state: structuredClone(state), revision: 0 }),
      save: (s: any) => {
        state = structuredClone(s);
        return { state, revision: 1 };
      },
      tasks: () => [...tasks.values()],
      putTask: (j: any) => tasks.set(j.id, j),
    };
    const config: any = {
      apiKey: () => 'test-key',
      platformSkills: () => catalog,
      savePlatformSkills: (s: any) => {
        catalog = s;
      },
    };
    const channels: any = {
      pauseForInitialization: async () => {},
      resumeAfterInitialization: () => {
        calls.push('resume');
      },
      resourceBindings: () => (binding ? [binding] : []),
      saveResourceBinding: (b: any) => {
        binding = structuredClone(b);
      },
    };
    t.mock.method(globalThis, 'fetch', async (url: any, options: any = {}) => {
      const path = new URL(url).pathname.replace('/api/v3', ''),
        method = options.method || 'GET';
      calls.push(`${method} ${path}`);
      if (path === '/skills' && method === 'GET') return Response.json({ data: [] });
      if (path === '/environments' && method === 'GET') return Response.json({ data: [] });
      const index = PLATFORM_SKILLS.findIndex((s) => path === `/skills/${s.id}`);
      if (index >= 0)
        return Response.json({
          id: PLATFORM_SKILLS[index].id,
          name: ADA_SKILL_NAMES[index],
          source: 'custom',
          latest_version: '1',
        });
      if (path === '/skills' && method === 'POST') {
        const name = options.body.get('files').name.replace('.zip', '');
        assert.ok(SOCIAL_SKILL_NAMES.includes(name));
        return Response.json({ id: `skill-${name}` });
      }
      const socialName = SOCIAL_SKILL_NAMES.find((name) => path === `/skills/skill-${name}`);
      if (socialName)
        return Response.json({
          id: `skill-${socialName}`,
          name: socialName,
          source: 'custom',
          latest_version: '1',
        });
      if (path === '/environments' && method === 'POST') return Response.json({ id: 'env-new' });
      if (path === '/environments/env-new')
        return Response.json({ id: 'env-new', config: { type: 'cloud' } });
      if (path === '/agents' && method === 'POST') {
        const body = JSON.parse(options.body);
        assert.equal(body.skills.length, 3);
        return Response.json({ id: 'agent-new', version: '1' });
      }
      if (path === '/vaults' && method === 'POST') return Response.json({ id: 'vault-new' });
      throw Error(`unexpected ${method} ${path}`);
    });
    const service = new MaInitializer(workspace, config, channels, {
      owner: (kind: string, id: string) => state[kind].find((o: any) => o.id === id),
    } as any);
    try {
      service.start();
      service.start();
      for (let i = 0; i < 100 && service.running; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(service.status().task?.status, 'completed', service.status().task?.progress);
      const created = calls.indexOf('POST /agents');
      assert.ok(created > 0);
      assert.ok(calls.slice(0, created).filter((p) => p.startsWith('GET /skills/')).length >= 3);
      assert.equal(calls.filter((c) => c === 'POST /agents').length, includeSocial ? 2 : 1);
      if (includeSocial)
        assert.deepEqual(
          state.employees[1].skills.map((s: any) => s.name),
          SOCIAL_SKILL_NAMES,
        );
      assert.equal(state.employees[0].skills.length, 3);
      assert.equal(binding.agentId, 'agent-new');
      assert.equal(calls.at(-1), 'resume');
    } finally {
      db.close();
    }
  });

import { Workforce } from '../src/workforce/domain.ts';
import { LocalWorkspace } from '../src/workforce/workspace.ts';
import { createWeb } from '../src/workforce/web.ts';
test('初始化 HTTP 入口拒绝跨站调用，初始化中禁止切换 Key，状态可读', async () => {
  const domain = new Workforce(':memory:'),
    workspace = new LocalWorkspace(':memory:');
  let starts = 0;
  const initializer: any = {
    running: false,
    status: () => ({ running: initializer.running }),
    start: () => {
      starts++;
      initializer.running = true;
      return initializer.status();
    },
  };
  const { server, url } = await createWeb(domain, { port: 0, workspace, initializer });
  try {
    const post = (path: string, origin?: string) =>
      fetch(url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: '{}',
      });
    assert.equal((await post('/api/workspace/ma-config/initialize', 'https://other.example')).status, 403);
    assert.equal((await post('/api/workspace/ma-config/initialize')).status, 202);
    assert.equal((await post('/api/workspace/ma-config/verify')).status, 409);
    assert.equal((await (await fetch(url + '/api/workspace/ma-config/initialize')).json()).running, true);
    assert.equal(starts, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    domain.close();
    workspace.close();
  }
});

test('未知创建结果仅在远端核验成功后恢复，不重复上传', async () => {
  const db = new DatabaseSync(':memory:');
  const registry = new MaResourceRegistry({ db } as any, 'key', { call: async () => ({}) });
  let posts = 0;
  const create = async () => {
    posts++;
    throw new Error('timeout');
  };
  try {
    await assert.rejects(registry.ensure('skill:test', '/skills', undefined, create));
    await assert.rejects(
      registry.ensure('skill:test', '/skills', undefined, create, async () => undefined),
      /未确认/,
    );
    const restored = await registry.ensure('skill:test', '/skills', undefined, create, async () => ({
      id: 'skill-existing',
    }));
    assert.equal(restored.resource.id, 'skill-existing');
    assert.equal(posts, 1);
    assert.equal(
      JSON.parse(String(db.prepare('SELECT payload FROM workspace_ma_resources').get()!.payload)).pending,
      undefined,
    );
  } finally {
    db.close();
  }
});

test('确定的上传前失败允许重试，不留下未知创建状态', async () => {
  const db = new DatabaseSync(':memory:');
  const registry = new MaResourceRegistry({ db } as any, 'key', { call: async () => ({}) });
  try {
    await assert.rejects(
      registry.ensure('skill:test', '/skills', undefined, async () => {
        throw new DomainError('打包失败', 400);
      }),
    );
    assert.equal(
      (await registry.ensure('skill:test', '/skills', undefined, async () => ({ id: 'skill-new' }))).created,
      true,
    );
  } finally {
    db.close();
  }
});

import { ensureTemplateSkills } from '../src/workforce/template-skills.ts';
import { createHash } from 'node:crypto';
for (const matches of [0, 1, 2])
  test(`技能恢复核验同名候选数量 ${matches}，不发送创建请求`, async (t) => {
    const workspace = new LocalWorkspace(':memory:');
    const key = 'recovery-test';
    new MaResourceRegistry(workspace, createHash('sha256').update(key).digest('hex'), {
      call: async () => ({}),
    });
    workspace.db
      .prepare('INSERT INTO workspace_ma_resources VALUES(?,?,?)')
      .run(
        createHash('sha256').update(key).digest('hex'),
        'skill:social-trend-data',
        JSON.stringify({ pending: true }),
      );
    const skill = { id: 'skill-existing', name: 'social-trend-data', source: 'custom', latest_version: '2' };
    let catalog: any[] = [];
    t.mock.method(globalThis, 'fetch', async (url: any, options: any) => {
      assert.equal(options.method, 'GET');
      return Response.json(
        new URL(url).pathname.endsWith('/skills')
          ? { data: Array.from({ length: matches }, () => skill) }
          : skill,
      );
    });
    try {
      const run = ensureTemplateSkills(
        workspace,
        {
          apiKey: () => key,
          platformSkills: () => catalog,
          savePlatformSkills: (s: any) => {
            catalog = s;
          },
        } as any,
        [{ name: skill.name, tags: ['social'] }],
      );
      if (matches === 1) assert.equal((await run)[0].id, skill.id);
      else await assert.rejects(run, matches ? /多个同名/ : /未确认/);
    } finally {
      workspace.close();
    }
  });

test('缺失 zip 时尚未上传且不残留 pending', async (t) => {
  const workspace = new LocalWorkspace(':memory:');
  const original = process.env.PATH;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ data: [] });
  });
  try {
    process.env.PATH = '/nonexistent-workforce-test';
    await assert.rejects(
      ensureTemplateSkills(workspace, { apiKey: () => 'test', platformSkills: () => [] } as any, [
        { name: 'social-trend-data', tags: [] },
      ]),
      /打包失败/,
    );
    assert.equal(requests, 1);
    assert.equal(workspace.db.prepare('SELECT COUNT(*) AS n FROM workspace_ma_resources').get()!.n, 0);
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
    workspace.close();
  }
});
