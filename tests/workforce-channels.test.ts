import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalWorkspace } from '../src/workforce/workspace.ts';
import { WorkspaceChannels, qrModules } from '../src/workforce/channels.ts';

function workspace() {
  const w = new LocalWorkspace(':memory:');
  w.save(
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
  return w;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(check(), '异步状态未完成');
}
test('应用创建幂等，确认后才绑定，密钥不返回页面', async () => {
  const w = workspace();
  let finish: any,
    count = 0,
    stopped = false;
  const channels = new WorkspaceChannels(w, {
    dataDir: '/tmp',
    register: async (options) => {
      count++;
      assert.equal(options.createOnly, true);
      options.onQRCodeReady({ url: 'https://open.feishu.cn/confirm', expireIn: 60 });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    provision: async () => {},
    connect: async () => async () => {
      stopped = true;
    },
  });
  try {
    channels.begin('e');
    channels.begin('e');
    assert.equal(count, 1);
    assert.equal(channels.view('e').status, 'awaiting_confirmation');
    finish({
      client_id: 'cli_test',
      client_secret: 'sensitive-secret',
      user_info: { open_id: 'ou_creator' },
    });
    await until(() => channels.view('e').status === 'connected');
    assert.equal(channels.view('e').appId, 'cli_test');
    assert.ok(!JSON.stringify(channels.view('e')).includes('sensitive-secret'));
    assert.equal(channels.view('e').url, undefined);
    channels.begin('e');
    assert.equal(count, 1);
  } finally {
    await channels.stop();
    w.close();
  }
  assert.equal(stopped, true);
});
test('后续步骤失败保留应用，重试不创建第二个应用，错误不泄露密钥', async () => {
  const w = workspace();
  let count = 0;
  const channels = new WorkspaceChannels(w, {
    dataDir: '/tmp',
    register: async () => {
      count++;
      return { client_id: 'cli_test', client_secret: 'secret' };
    },
    provision: async () => {
      throw new Error('request contained secret');
    },
  });
  try {
    channels.begin('e');
    await until(() => channels.view('e').status === 'error');
    assert.ok(!JSON.stringify(channels.view('e')).includes('secret'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    channels.begin('e');
    await until(() => channels.view('e').status === 'error');
    assert.equal(count, 1);
  } finally {
    await channels.stop();
    w.close();
  }
});
test('未确认创建在重启后不自动重复申请，状态隔离于客户端工作台数据', async () => {
  const w = workspace();
  w.db.exec('CREATE TABLE workspace_channels (employee_id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  w.db
    .prepare('INSERT INTO workspace_channels VALUES (?,?)')
    .run('e', JSON.stringify({ employeeId: 'e', status: 'creating' }));
  const channels = new WorkspaceChannels(w, { dataDir: '/tmp' });
  try {
    assert.equal(channels.view('e').status, 'interrupted');
    assert.throws(() => channels.begin('e'), /核查/);
    assert.throws(() => channels.view('missing'), /不存在/);
    assert.ok(!JSON.stringify(w.read()).includes('workspace_channels'));
    const modules = qrModules('https://open.feishu.cn/confirm');
    assert.ok(modules.length > 20 && modules.every((row: any[]) => row.length === modules.length));
  } finally {
    await channels.stop();
    w.close();
  }
});
test('创建中断后，仅明确确认未创建才重新发起', async () => {
  const w = workspace();
  let count = 0;
  const channels = new WorkspaceChannels(w, {
    dataDir: '/tmp',
    register: async () => {
      count++;
      throw new Error('expired');
    },
  });
  try {
    channels.begin('e');
    await until(() => channels.view('e').status === 'error');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.throws(() => channels.begin('e'), /核查/);
    channels.begin('e', true);
    await until(() => count === 2);
  } finally {
    await channels.stop();
    w.close();
  }
});
test('已有应用补权固定 App ID，不创建新应用或覆盖 MA 资源', async () => {
  const w = workspace();
  let finish: any;
  const channels = new WorkspaceChannels(w, {
    dataDir: '/tmp',
    provision: async () => {},
    connect: async () => async () => {},
    register: async (options) => {
      assert.equal(options.appId, 'cli_existing');
      assert.notEqual(options.createOnly, true);
      assert.ok(options.addons?.scopes?.tenant?.includes('cardkit:card:write'));
      options.onQRCodeReady({ url: 'https://open.feishu.cn/confirm', expireIn: 60 });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  w.db.prepare('INSERT INTO workspace_channels VALUES (?,?)').run(
    'e',
    JSON.stringify({
      employeeId: 'e',
      appId: 'cli_existing',
      appSecret: 'original-secret',
      agentId: 'agent_existing',
      status: 'stopped',
    }),
  );
  try {
    channels.upgradePermissions('e');
    assert.equal(channels.view('e').status, 'awaiting_permission_confirmation');
    finish({ client_id: 'cli_existing', client_secret: 'secret' });
    await until(() => channels.view('e').status === 'connected');
    const stored = JSON.parse(
      (w.db.prepare('SELECT payload FROM workspace_channels WHERE employee_id=?').get('e') as any).payload,
    );
    assert.equal(stored.agentId, 'agent_existing');
    assert.equal(channels.view('e').permissionsVersion, 2);
    assert.ok(!JSON.stringify(channels.view('e')).includes('secret'));
  } finally {
    await channels.stop();
    w.close();
  }
});

test('补权返回其他应用时拒绝替换原绑定', async () => {
  const w = workspace();
  const channels = new WorkspaceChannels(w, {
    dataDir: '/tmp',
    register: async () => ({ client_id: 'cli_other', client_secret: 'new-secret' }),
  });
  w.db.prepare('INSERT INTO workspace_channels VALUES (?,?)').run(
    'e',
    JSON.stringify({
      employeeId: 'e',
      appId: 'cli_existing',
      appSecret: 'original-secret',
      status: 'stopped',
    }),
  );
  try {
    channels.upgradePermissions('e');
    await until(() => channels.view('e').status === 'awaiting_permissions');
    assert.equal(channels.view('e').appId, 'cli_existing');
    assert.equal(channels.view('e').permissionsVersion, 1);
  } finally {
    await channels.stop();
    w.close();
  }
});

test('已有员工配置可同步 MA，重复请求不重复更新，页面能识别后续草稿变更', async () => {
  const w = workspace();
  let updates = 0;
  const channels = new WorkspaceChannels(w, {
    dataDir: '/tmp',
    ark: () =>
      ({
        getAgent: async () => ({ id: 'agent-test', version: '1' }),
        updateAgent: async (_id: any, _version: any, config: any) => {
          updates++;
          assert.equal(config.name, '助手');
          return { id: 'agent-test', version: '2' };
        },
      }) as any,
  });
  w.db
    .prepare('INSERT INTO workspace_channels VALUES (?,?)')
    .run(
      'e',
      JSON.stringify({ employeeId: 'e', agentId: 'agent-test', appId: 'cli-test', status: 'connected' }),
    );
  try {
    await Promise.all([channels.syncAgent('e'), channels.syncAgent('e')]);
    assert.equal(updates, 1);
    assert.equal(channels.view('e').configurationSynced, true);
    const latest = w.read();
    latest.state.employees[0].identity = '新身份';
    w.save(latest.state, latest.revision);
    assert.equal(channels.view('e').configurationSynced, false);
    await channels.syncAgent('e');
    assert.equal(updates, 2);
  } finally {
    await channels.stop();
    w.close();
  }
});

test('已有应用验证后复用准备与连接流程，不创建新应用且不回传密钥', async () => {
  const w = workspace();
  let created = 0,
    prepared = 0,
    connected = 0;
  const channels = new WorkspaceChannels(w, {
    dataDir: '/tmp',
    register: async () => {
      created++;
      throw new Error('不应创建');
    },
    fetcher: async (url, options) => {
      assert.equal(String(url), 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
      assert.equal(JSON.parse(String(options?.body)).app_id, 'cli_existing123');
      return Response.json({ code: 0, tenant_access_token: 'test-token' });
    },
    provision: async (b) => {
      assert.equal(b.appSecret, 'test-secret');
      prepared++;
    },
    connect: async () => {
      connected++;
      return async () => {};
    },
  });
  try {
    await channels.bindExisting('e', { appId: 'cli_existing123', appSecret: 'test-secret' });
    await until(() => channels.view('e').status === 'connected');
    assert.equal(created, 0);
    assert.equal(prepared, 1);
    assert.equal(connected, 1);
    assert.ok(!JSON.stringify(channels.view('e')).includes('test-secret'));
    await assert.rejects(
      channels.bindExisting('e', { appId: 'cli_other123', appSecret: 'new-secret' }),
      /已绑定/,
    );
    assert.equal(channels.view('e').appId, 'cli_existing123');
  } finally {
    await channels.stop();
    w.close();
  }
});

test('已有应用凭证错误不保存绑定，允许修正后重试', async () => {
  const w = workspace();
  let valid = false;
  const channels = new WorkspaceChannels(w, {
    dataDir: '/tmp',
    fetcher: async () =>
      Response.json(
        valid ? { code: 0, tenant_access_token: 'token' } : { code: 10014, msg: 'sensitive-response' },
      ),
    provision: async () => {},
    connect: async () => async () => {},
  });
  try {
    await assert.rejects(
      channels.bindExisting('e', { appId: 'cli_existing123', appSecret: 'wrong' }),
      /验证失败/,
    );
    assert.equal(channels.view('e').status, 'unbound');
    valid = true;
    await channels.bindExisting('e', { appId: 'cli_existing123', appSecret: 'correct' });
    await until(() => channels.view('e').status === 'connected');
  } finally {
    await channels.stop();
    w.close();
  }
});

test('已有应用并发接入和重复绑定均被拦截', async () => {
  const w = workspace();
  const snapshot = w.read();
  snapshot.state.employees.push({
    ...structuredClone(snapshot.state.employees[0]),
    id: 'second',
    name: '其他员工',
  });
  w.save(snapshot.state, snapshot.revision);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const channels = new WorkspaceChannels(w, {
    dataDir: '/tmp',
    fetcher: async () => {
      await gate;
      return Response.json({ code: 0, tenant_access_token: 'token' });
    },
    provision: async () => {},
    connect: async () => async () => {},
  });
  try {
    const first = channels.bindExisting('e', { appId: 'cli_existing123', appSecret: 'secret' });
    await assert.rejects(
      channels.bindExisting('second', { appId: 'cli_existing123', appSecret: 'secret' }),
      /其他数字员工或正在接入/,
    );
    release();
    await first;
    await until(() => channels.view('e').status === 'connected');
    await assert.rejects(
      channels.bindExisting('second', { appId: 'cli_existing123', appSecret: 'secret' }),
      /其他数字员工/,
    );
  } finally {
    release();
    await channels.stop();
    w.close();
  }
});

test('初始化暂停后可自动恢复，服务关闭后不再恢复', async () => {
  const w = workspace();
  let starts = 0,
    stops = 0;
  const channels = new WorkspaceChannels(w, {
    dataDir: '/tmp',
    register: async () => ({ client_id: 'cli_pause_test', client_secret: 'secret' }),
    provision: async () => {},
    connect: async () => {
      starts++;
      return async () => {
        stops++;
      };
    },
  });
  try {
    channels.begin('e');
    await until(() => channels.view('e').status === 'connected');
    await until(() => !(channels as any).active.size);
    await channels.pauseForInitialization();
    assert.equal(stops, 1);
    assert.throws(() => channels.begin('e'), /初始化/);
    channels.resumeAfterInitialization();
    await until(() => starts === 2);
    await until(() => !(channels as any).active.size);
    await channels.pauseForInitialization();
    await channels.stop();
    channels.resumeAfterInitialization();
    assert.equal(starts, 2);
  } finally {
    await channels.stop();
    w.close();
  }
});
