import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function fixture(storage = new Map<string, string>()) {
  return runInNewContext(
    source.slice(0, source.indexOf('let data =')) +
      '\n({ seed, snapshot, repository, migrateMemories, memoryError, activeTasks, memoryTree });',
    {
      structuredClone,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    },
  );
}

test('前端发布快照独立于后续配置和员工记忆', () => {
  const { seed, snapshot } = fixture();
  const employee = seed().employees[0];
  const version = snapshot(employee);
  employee.skills[0].name = '后续调整';
  assert.equal(version.skills[0].name, 'Brief 分析');
  assert.equal('memories' in version, false);
  assert.equal('versions' in version, false);
});

test('旧记忆迁移到默认库后保留内容且重复迁移稳定', () => {
  const { seed, migrateMemories } = fixture();
  const data = seed();
  const content = data.projects[0].memories[0].content;
  migrateMemories(data);
  const once = JSON.stringify(data);
  migrateMemories(data);
  assert.equal(JSON.stringify(data), once);
  assert.equal(data.projects[0].memories[0].content, content);
  assert.equal(data.projects[0].memories[0].path, 'notes/pm1.md');
});

test('同库重复路径被拒绝，不同库允许同名路径，编辑自身允许保留路径', () => {
  const { repository, memoryError } = fixture();
  const owner = repository.load().employees[0];
  const entry = owner.memories[0];
  assert.match(memoryError(owner, entry), /已存在/);
  assert.equal(memoryError(owner, entry, entry.id), '');
  owner.memoryStores.push({ id: 'other', name: '其他库' });
  assert.equal(memoryError(owner, { ...entry, storeId: 'other' }), '');
  assert.match(memoryError(owner, { ...entry, path: '../notes.md' }), /有效/);
});

test('库与条目刷新后保留且不进入员工配置版本', () => {
  const { repository, snapshot } = fixture();
  const data = repository.load();
  const owner = data.employees[0];
  owner.memoryStores.push({ id: 'work', name: '工作经验' });
  Object.assign(owner.memories[0], { storeId: 'work', path: 'notes/偏好.md', content: '  原始文本\n' });
  repository.save(data);
  assert.equal(repository.load().employees[0].memories[0].content, '  原始文本\n');
  assert.equal(repository.load().employees[0].memories[0].storeId, 'work');
  assert.equal('memoryStores' in snapshot(owner), false);
});

test('浏览器刷新后保留员工配置和项目成员权限', () => {
  const { repository } = fixture();
  const data = repository.load();
  data.projects[0].members[1].permission = 'read';
  data.employees[0].identity = '新的职责';
  assert.equal(repository.save(data), true);
  const restored = repository.load();
  assert.equal(restored.projects[0].members[1].permission, 'read');
  assert.equal(restored.employees[0].identity, '新的职责');
});

test('损坏的本地演示数据不会导致首次页面无法初始化', () => {
  const { repository } = fixture(new Map([['workforce.frontend.v1', 'not-json']]));
  assert.equal(repository.load().employees.length, 2);
});

test('路径树将同名文件分配到各自目录并支持根目录条目', () => {
  const { memoryTree } = fixture();
  const tree = memoryTree([
    { id: 'a', path: 'notes/brief.md' },
    { id: 'b', path: 'archive/2026/brief.md' },
    { id: 'c', path: 'README.md' },
  ]);
  assert.equal(tree.folders.get('notes').files[0].id, 'a');
  assert.equal(tree.folders.get('archive').folders.get('2026').files[0].id, 'b');
  assert.equal(tree.files[0].filename, 'README.md');
});

test('运行中的任务只包含执行中和等待中的任务', () => {
  const { activeTasks } = fixture();
  const rows = ['running', 'queued', 'completed', 'failed', 'cancelled'].map((status) => ({ status }));
  assert.equal(JSON.stringify(activeTasks(rows)), JSON.stringify(rows.slice(0, 2)));
});

test('旧浏览器数据补充演示任务且已保存任务不被重新初始化', () => {
  const { repository, seed } = fixture();
  const old = seed();
  old.employees[0].name = '保留名称';
  repository.save(old);
  const migrated = repository.load();
  assert.equal(migrated.employees[0].name, '保留名称');
  assert.equal(migrated.tasks.length, 3);
  migrated.tasks = [];
  repository.save(migrated);
  assert.equal(repository.load().tasks.length, 0);
});

test('空白服务首次连接使用服务端状态，不导入浏览器演示群聊', async () => {
  const state = { employees: [], projects: [], groups: [], tasks: [] };
  const calls: any[] = [];
  let accepted: any;
  const connect = runInNewContext(
    source.slice(source.indexOf('async function connectWorkspace()'), source.indexOf("let search = ''")) +
      '\nconnectWorkspace;',
    {
      $: () => ({}),
      request: async (_path: string, method?: string, payload?: any) => {
        calls.push({ method, payload });
        return { initialized: method === 'PUT', revision: method === 'PUT' ? 1 : 0, state };
      },
      repository: {
        load: () => {
          throw new Error('不应读取浏览器演示数据');
        },
      },
      migrateMemories: structuredClone,
      acceptServer: (result: any) => {
        accepted = result;
      },
      refreshMaStatus: async () => {},
      render: () => {},
      paintMaStatus: () => {},
      empty: () => '',
      esc: String,
      button: () => '',
    },
  );
  await connect();
  assert.equal(accepted?.initialized, true);
  assert.equal(JSON.stringify(calls[1].payload.state), JSON.stringify(state));
});
