import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalWorkspace } from '../src/workforce/workspace.ts';
import { MaConfiguration } from '../src/workforce/ma-config.ts';
import { MaInitializer } from '../src/workforce/ma-initializer.ts';
import { employeeTemplates, initializeEmployeeTemplate } from '../src/workforce/employee-templates.ts';
import { SOCIAL_SKILL_NAMES } from '../src/workforce/social-template.ts';
import { PLATFORM_SKILLS } from '../src/workforce/skill-catalog.ts';
import { Workforce } from '../src/workforce/domain.ts';
import { createWeb } from '../src/workforce/web.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'social-template-'));
  const workspace = new LocalWorkspace(':memory:');
  const config = new MaConfiguration(directory, {});
  const initializer = new MaInitializer(workspace, config, {} as any, {} as any);
  return {
    workspace,
    config,
    initializer,
    close: () => {
      workspace.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('两类模板独立幂等，不覆盖用户内容，无 Key 时不产生模拟技能', async () => {
  const f = fixture();
  try {
    const ada = await f.initializer.initializeTemplate('ada');
    const social = await f.initializer.initializeTemplate('social-trends');
    assert.notEqual(ada.employeeId, social.employeeId);
    assert.equal(social.skillStatus, 'pending');
    const state = f.workspace.read();
    const employee = state.state.employees.find((e: any) => e.id === social.employeeId);
    assert.equal(employee.memories.length, 6);
    const dependencies = JSON.parse(
      employee.memories.find((m: any) => m.path === 'config/dependencies.json').content,
    );
    assert.equal(dependencies.schedule.enabled, false);
    assert.equal(dependencies.input.mcp_tool, null);
    assert.equal(employee.skills.length, 0);
    employee.identity = '用户定制身份';
    f.workspace.save(state.state, state.revision);
    const again = await f.initializer.initializeTemplate('social-trends');
    assert.equal(again.created, false);
    assert.equal(again.state.employees.find((e: any) => e.id === social.employeeId).identity, '用户定制身份');
    assert.throws(() => initializeEmployeeTemplate(f.workspace, '../invalid'), /不存在/);
  } finally {
    f.close();
  }
});

test('社媒与 ADA 技能真实上传和回读后绑定，目录合并且重试不重复上传', async (t) => {
  const f = fixture();
  f.config.save('fixture-key');
  const remote = new Map(
    PLATFORM_SKILLS.map((s) => [s.id, { id: s.id, name: s.name, source: 'custom', latest_version: '1' }]),
  );
  let uploads = 0;
  t.mock.method(globalThis, 'fetch', async (url: any, options: any = {}) => {
    const path = new URL(url).pathname;
    if (options.method === 'POST') {
      assert.equal(path, '/api/v3/skills');
      assert.ok(options.body instanceof FormData);
      const file = options.body.get('files');
      assert.ok(file instanceof Blob);
      assert.ok(file.size > 100);
      const name = file.name.replace('.zip', '');
      assert.ok(SOCIAL_SKILL_NAMES.includes(name));
      const id = `skill-social-${++uploads}`;
      remote.set(id, { id, name, source: 'custom', latest_version: '1' });
      return Response.json({ id });
    }
    if (path === '/api/v3/skills') return Response.json({ data: [...remote.values()] });
    const skill = remote.get(path.split('/').at(-1)!);
    return skill ? Response.json(skill) : Response.json({}, { status: 404 });
  });
  try {
    const social = await f.initializer.initializeTemplate('social-trends');
    assert.equal(social.skillStatus, 'ready');
    await f.initializer.initializeTemplate('ada');
    assert.equal(f.config.platformSkills()?.length, 6);
    let state = f.workspace.read();
    const e = state.state.employees.find((e: any) => e.id === social.employeeId);
    assert.deepEqual(
      e.skills.map((s: any) => s.name),
      SOCIAL_SKILL_NAMES,
    );
    e.identity = '保留用户身份';
    e.skills[0].enabled = false;
    f.workspace.save(state.state, state.revision);
    await f.initializer.initializeTemplate('social-trends');
    state = f.workspace.read();
    const after = state.state.employees.find((e: any) => e.id === social.employeeId);
    assert.equal(after.identity, '保留用户身份');
    assert.equal(after.skills[0].enabled, false);
    assert.equal(uploads, 3);
    assert.equal(state.state.employees.find((e: any) => e.name === 'ADA').skills.length, 3);
    assert.equal(f.config.platformSkills()?.filter((s) => s.tags.includes('social-trends')).length, 3);
  } finally {
    f.close();
  }
});

test('部分上传失败保留已成功的目录，未知结果重试不再创建', async (t) => {
  const f = fixture();
  f.config.save('fixture-key');
  let uploads = 0;
  t.mock.method(globalThis, 'fetch', async (url: any, options: any = {}) => {
    if (options.method === 'POST') {
      uploads++;
      if (uploads === 2) throw Error('network timeout');
      return Response.json({ id: 'skill-first' });
    }
    if (new URL(url).pathname === '/api/v3/skills') return Response.json({ data: [] });
    return Response.json({
      id: 'skill-first',
      name: SOCIAL_SKILL_NAMES[0],
      source: 'custom',
      latest_version: '1',
    });
  });
  try {
    await assert.rejects(f.initializer.initializeTemplate('social-trends'));
    assert.equal(f.config.platformSkills()?.length, 1);
    assert.equal(f.workspace.read().state.employees.length, 0);
    await assert.rejects(f.initializer.initializeTemplate('social-trends'), /未确认/);
    assert.equal(uploads, 2);
    assert.equal(f.initializer.running, false);
  } finally {
    f.close();
  }
});

test('模板列表与社媒初始化 API 可用，禁止跨站初始化', async () => {
  const f = fixture();
  const domain = new Workforce(':memory:');
  const { server, url } = await createWeb(domain, {
    port: 0,
    workspace: f.workspace,
    initializer: f.initializer,
  });
  try {
    const list = await (await fetch(url + '/api/workspace/employee-templates')).json();
    assert.deepEqual(
      list.templates.map((t: any) => t.key),
      ['ada', 'social-trends'],
    );
    assert.equal(JSON.stringify(list).includes('createSocialEmployee'), false);
    const endpoint = url + '/api/workspace/employee-templates/social-trends/initialize';
    assert.equal(
      (await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://other.example' }, body: '{}' }))
        .status,
      403,
    );
    const result = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).state.employees[0].name, '社媒热点分析员工');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    domain.close();
    f.close();
  }
});

test('数据脚本保留零与缺失差别，过滤重复和越界，样本不能自动通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'social-data-'));
  try {
    const row = {
      record_id: '1',
      platform: 'P',
      title: '示例事件',
      source_url: 'https://example.com/event',
      published_at: '2026-09-21T12:00:00+08:00',
      views: 0,
    };
    writeFileSync(
      join(dir, 'input.json'),
      JSON.stringify([
        row,
        row,
        { ...row, record_id: '2', published_at: '2026-09-28T00:00:00+08:00' },
        { ...row, record_id: '3', views: -1 },
      ]),
    );
    const args = [
      resolve('skills/social-trend-data/scripts/prepare.py'),
      '--input',
      join(dir, 'input.json'),
      '--out',
      join(dir, 'output'),
      '--start',
      '2026-09-21T00:00:00+08:00',
      '--end',
      '2026-09-28T00:00:00+08:00',
    ];
    const result = spawnSync('python3', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const records = JSON.parse(readFileSync(join(dir, 'output/normalized.json'), 'utf8'));
    assert.equal(records.length, 1);
    assert.equal(records[0].views, 0);
    assert.equal(records[0].likes, null);
    const quality = JSON.parse(readFileSync(join(dir, 'output/quality.json'), 'utf8'));
    assert.equal(quality.approved, false);
    assert.equal(quality.label_agreement, null);
    assert.equal(quality.issues.length, 3);
    assert.notEqual(spawnSync('python3', args, { encoding: 'utf8' }).status, 0);
    assert.equal(existsSync(join(dir, 'output/sample.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('所有场景技能源码名称与上传目录一致', () => {
  for (const template of employeeTemplates)
    for (const skill of template.skills)
      assert.ok(
        readFileSync(resolve('skills', skill.name, 'SKILL.md'), 'utf8').includes(`name: ${skill.name}\n`),
      );
});

test('最终产物验证器拒绝跨批次、缺失来源、注入、伪发布和未解决项', () => {
  const result = spawnSync('python3', ['skills/social-trend-report/scripts/test_validate.py'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('旧报告技能升级一次，创建后回读暂时失败不丢失新资源回执', async (t) => {
  const f = fixture();
  f.config.save('fixture-key');
  const { ensureTemplateSkills } = await import('../src/workforce/template-skills.ts');
  f.config.savePlatformSkills([
    { id: 'skill-old-report', name: 'social-trend-report', tags: ['social-trends'] },
  ]);
  let uploads = 0;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url: any, options: any = {}) => {
    if (options.method === 'POST') {
      uploads++;
      return Response.json({ id: 'skill-new-report' });
    }
    assert.ok(String(url).endsWith('/skills/skill-new-report'));
    if (++reads === 1) return Response.json({}, { status: 503 });
    return Response.json({
      id: 'skill-new-report',
      name: 'social-trend-report',
      source: 'custom',
      latest_version: '1',
    });
  });
  const specs = [{ name: 'social-trend-report', tags: ['social-trends'], revision: 'validator-v1' }];
  try {
    await assert.rejects(ensureTemplateSkills(f.workspace, f.config, specs));
    const skills = await ensureTemplateSkills(f.workspace, f.config, specs);
    assert.equal(skills[0].id, 'skill-new-report');
    await ensureTemplateSkills(f.workspace, f.config, specs);
    assert.equal(uploads, 1);
  } finally {
    f.close();
  }
});
