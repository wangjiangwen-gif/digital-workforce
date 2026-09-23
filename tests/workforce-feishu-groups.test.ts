import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuGroups, parseLarkResult } from '../src/workforce/feishu-groups.ts';
import { LocalWorkspace } from '../src/workforce/workspace.ts';

test('成员查询只返回展示字段并保留分页，撤销管理权限后拒绝读取', async () => {
  const workspace = new LocalWorkspace(':memory:');
  workspace.save(
    {
      employees: [],
      projects: [],
      groups: [{ id: 'g', name: '群', chatId: 'oc_test', projectId: '', employeeIds: [], source: 'feishu' }],
    },
    0,
  );
  let allowed = true;
  let reads = 0;
  const service = new FeishuGroups(workspace, {} as any, async (args) => {
    if (args[0] === 'auth') return { identities: { user: { verified: true, openId: 'ou_me' } } };
    if (args[1] === 'chats')
      return { owner_id: allowed ? 'ou_me' : 'ou_other', chat_mode: 'group', chat_status: 'normal' };
    reads++;
    assert.ok(args.includes('--check-security-conf'));
    assert.ok(args.includes('cursor'));
    return {
      items: [{ member_id: 'ou_member', name: '成员', tenant_key: 'private' }],
      has_more: true,
      page_token: 'next',
      member_total: 3,
    };
  });
  try {
    const page = await service.members('g', 'cursor');
    assert.deepEqual(page.members, [{ id: 'ou_member', name: '成员' }]);
    assert.equal(page.pageToken, 'next');
    allowed = false;
    await assert.rejects(service.members('g'), /管理权限/);
    assert.equal(reads, 1);
    await assert.rejects(service.members('missing'), /不存在/);
  } finally {
    workspace.close();
  }
});

function fixture() {
  const workspace = new LocalWorkspace(':memory:');
  workspace.save(
    {
      employees: [
        {
          id: 'e',
          name: '助手',
          enabled: true,
          identity: '',
          knowledge: '',
          rules: '',
          environment: { timeout: 300 },
          skills: [],
          credentials: [],
          memories: [],
          memoryStores: [],
          versions: [],
          activeVersion: null,
          channels: { feishu: { enabled: false, appId: '' }, doubao: { enabled: false, agentId: '' } },
        },
      ],
      projects: [],
      groups: [],
    },
    0,
  );
  const calls: string[][] = [];
  let role = 'owner';
  let response: any = {};
  const service = new FeishuGroups(
    workspace,
    { view: () => ({ status: 'connected', appId: 'cli_bound' }) } as any,
    async (args) => {
      calls.push(args);
      if (args[0] === 'auth')
        return { identities: { user: { verified: true, openId: 'ou_me', userName: '测试用户' } } };
      if (args[1] === '+chat-list')
        return {
          chats: [{ chat_id: 'oc_owner' }, { chat_id: 'oc_manager' }, { chat_id: 'oc_member' }],
          has_more: true,
          page_token: 'next',
        };
      if (args[1] === 'chats') {
        const id = args[args.indexOf('--chat-id') + 1];
        return {
          name: '测试群',
          chat_mode: 'group',
          chat_status: 'normal',
          owner_id: id === 'oc_owner' && role === 'owner' ? 'ou_me' : 'ou_other',
          user_manager_id_list: id === 'oc_manager' ? ['ou_me'] : [],
        };
      }
      if (response instanceof Error) throw response;
      return response;
    },
  );
  return {
    workspace,
    service,
    calls,
    role: (value: string) => {
      role = value;
    },
    response: (value: any) => {
      response = value;
    },
  };
}
test('分页保留群主和管理员，过滤普通成员', async () => {
  const f = fixture();
  try {
    const result = await f.service.list('cursor');
    assert.deepEqual(
      result.groups.map((g) => g.chatId),
      ['oc_owner', 'oc_manager'],
    );
    assert.equal(result.pageToken, 'next');
    const listCall = f.calls.find((args) => args.includes('+chat-list'))!;
    assert.equal(listCall[listCall.indexOf('--page-size') + 1], '100');
    assert.ok(f.calls.find((args) => args.includes('cursor')));
  } finally {
    f.workspace.close();
  }
});
test('关联群聊通过飞书核验且不会添加机器人或项目员工', async () => {
  const f = fixture();
  try {
    const current = f.workspace.read();
    current.state.projects.push({
      id: 'p',
      name: '项目',
      groups: [],
      memoryStores: [],
      memories: [],
      members: [{ id: 'm', name: '负责人', account: 'local-admin', permission: 'manage' }],
    });
    f.workspace.save(current.state, current.revision);
    await f.service.import('oc_owner', 'p');
    await f.service.import('oc_owner', 'p');
    assert.equal(f.workspace.read().state.groups.length, 1);
    assert.equal(f.workspace.read().state.groups[0].projectId, 'p');
    assert.deepEqual(f.workspace.read().state.groups[0].employeeIds, []);
    assert.deepEqual(f.workspace.read().state.projects[0].employees, []);
    f.role('member');
    await assert.rejects(f.service.import('oc_owner', 'p'), /管理员/);
  } finally {
    f.workspace.close();
  }
});
test('工作台禁用邀请机器人，且不请求飞书写接口', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.add('oc_owner', 'e'), /仅查看/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.workspace.close();
  }
});

async function projectFixture() {
  const f = fixture();
  const current = f.workspace.read();
  current.state.projects.push({
    id: 'p',
    name: '项目',
    groups: [],
    memoryStores: [],
    memories: [],
    members: [{ id: 'm', name: '负责人', account: 'local-admin', permission: 'manage' }],
  });
  f.workspace.save(current.state, current.revision);
  await f.service.import('oc_owner', 'p');
  return { ...f, groupId: f.workspace.read().state.groups[0].id };
}
test('项目内邀请使用服务端 App ID，成功后更新在群状态，不建立项目员工名单', async () => {
  const f = await projectFixture();
  try {
    await f.service.invite('p', f.groupId, 'e');
    await f.service.invite('p', f.groupId, 'e');
    assert.deepEqual(f.workspace.read().state.groups[0].employeeIds, ['e']);
    assert.deepEqual(f.workspace.read().state.projects[0].employees, []);
    const call = f.calls.find((args) => args.includes('create'))!;
    assert.deepEqual(JSON.parse(call[call.indexOf('--data') + 1]), { id_list: ['cli_bound'] });
    await assert.rejects(f.service.invite('other', f.groupId, 'e'), /关联已变化/);
  } finally {
    f.workspace.close();
  }
});
test('项目邀请待审批、无效机器人及管理权限撤回不写入在群状态', async () => {
  const f = await projectFixture();
  try {
    for (const response of [
      { pending_approval_id_list: ['cli_bound'] },
      { invalid_id_list: ['cli_bound'] },
      new Error('failed'),
    ]) {
      f.response(response);
      await assert.rejects(f.service.invite('p', f.groupId, 'e'));
      assert.deepEqual(f.workspace.read().state.groups[0].employeeIds, []);
    }
    f.role('member');
    await assert.rejects(f.service.invite('p', f.groupId, 'e'), /管理权限/);
  } finally {
    f.workspace.close();
  }
});

test('外部群添加失败展示明确原因，其他错误不透传敏感内容', () => {
  assert.throws(
    () => parseLarkResult(JSON.stringify({ ok: false, error: { code: 232033, message: 'raw secret' } })),
    /外部群.*232033/,
  );
  assert.throws(
    () => parseLarkResult(JSON.stringify({ ok: false, error: { code: 999, message: 'raw secret' } })),
    (error: Error) => error.message.includes('999') && !error.message.includes('raw secret'),
  );
  assert.deepEqual(parseLarkResult(JSON.stringify({ ok: true, data: { items: [] } })), { items: [] });
});

test('手动群 ID 关联无需个人凭证，幂等且不伪造在群员工', () => {
  const f = fixture();
  const id = 'oc_e35611bee2ba981bafc156118228a955';
  try {
    const current = f.workspace.read();
    current.state.projects.push(
      ...['p', 'other'].map((id) => ({ id, name: id, groups: [], memories: [], memoryStores: [] })),
    );
    f.workspace.save(current.state, current.revision);
    f.service.importManual(' ' + id + ' ', 'p');
    const result = f.service.importManual(id, 'p');
    assert.equal(result.state.groups.length, 1);
    assert.equal(result.state.groups[0].projectId, 'p');
    assert.equal(result.state.groups[0].source, 'manual');
    assert.deepEqual(result.state.groups[0].employeeIds, []);
    assert.equal(f.calls.length, 0);
    assert.throws(() => f.service.importManual(id, 'other'), /其他项目/);
    assert.throws(() => f.service.importManual(id, 'missing'), /项目不存在/);
    for (const bad of ['oc_test', 'ou_e35611bee2ba981bafc156118228a955', 'https://feishu.cn/group'])
      assert.throws(() => f.service.importManual(bad, 'p'), /Chat ID/);
  } finally {
    f.workspace.close();
  }
});
