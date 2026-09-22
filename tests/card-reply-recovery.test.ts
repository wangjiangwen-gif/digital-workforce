import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverLarkReply } from '../src/lark-reply-inspection.ts';
import { replyContentFingerprint } from '../src/reply-delivery.ts';
const message: any = {
  channelType: 'lark',
  installationId: 'cli',
  tenantId: 'tenant',
  conversationId: 'chat',
  threadId: '',
};
const request = {
  cardId: 'card',
  messageId: 'reply',
  elementId: 'body',
  sequence: 11,
  content: 'final',
  contentFingerprint: replyContentFingerprint('final'),
};
function fixture(overrides: any = {}, code = 0) {
  const updates: any[] = [];
  const item = {
    message_id: 'reply',
    chat_id: 'chat',
    msg_type: 'interactive',
    deleted: false,
    sender: { id: 'cli', id_type: 'app_id', sender_type: 'app', tenant_key: 'tenant' },
    body: {
      content: JSON.stringify({
        schema: '2.0',
        config: { streaming_mode: true },
        body: { elements: [{ tag: 'markdown', element_id: 'body', content: 'partial' }] },
      }),
    },
    ...overrides,
  };
  const client = {
    im: { message: { get: async () => ({ code: 0, data: { items: [item] } }) } },
    cardkit: {
      v1: {
        card: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return { code };
          },
        },
      },
    },
  };
  return { client, updates };
}
test('补完原卡片并关闭流式，重试保持同一序号与 UUID', async () => {
  const { client, updates } = fixture();
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await recoverLarkReply(client, 'cli', message, request, new AbortController().signal)).status,
      'confirmed',
    );
  assert.deepEqual(updates[0], updates[1]);
  assert.equal(updates[0].path.card_id, 'card');
  const card = JSON.parse(updates[0].data.card.data);
  assert.equal(card.config.streaming_mode, false);
  assert.equal(card.body.elements[0].content, 'final');
});
test('错误身份或元素不更新，业务失败不确认', async () => {
  const wrong = fixture({ sender: { id: 'other' } });
  await recoverLarkReply(wrong.client, 'cli', message, request, new AbortController().signal);
  assert.equal(wrong.updates.length, 0);
  const element = fixture({
    body: {
      content: JSON.stringify({
        schema: '2.0',
        config: { streaming_mode: true },
        body: { elements: [{ tag: 'markdown', element_id: 'other', content: 'partial' }] },
      }),
    },
  });
  await recoverLarkReply(element.client, 'cli', message, request, new AbortController().signal);
  assert.equal(element.updates.length, 0);
  const failed = fixture({}, 123);
  assert.equal(
    (await recoverLarkReply(failed.client, 'cli', message, request, new AbortController().signal)).status,
    'unknown',
  );
});
test('正文指纹错误或取消不修改卡片', async () => {
  const { client, updates } = fixture();
  await recoverLarkReply(
    client,
    'cli',
    message,
    { ...request, content: 'changed' },
    new AbortController().signal,
  );
  await recoverLarkReply(client, 'cli', message, request, AbortSignal.abort());
  assert.equal(updates.length, 0);
});

import { GatewayStore } from '../src/store.ts';
import { Gateway, type GatewayOptions } from '../src/gateway.ts';
import { setImmediate as flush } from 'node:timers/promises';
const opts: GatewayOptions = {
  agentId: 'agent',
  environmentId: 'env',
  vaultId: 'vault',
  appId: 'cli',
  platformAccess: true,
  sharedGroupSessions: true,
  durableQueue: true,
  timeoutMs: 1000,
  sessionCompaction: false,
};
const incoming: any = {
  ...message,
  senderId: 'user',
  conversationType: 'group',
  rootMessageId: '',
  parentMessageId: '',
  messageId: 'first',
  eventId: 'first',
  createTime: 1,
  text: 'first',
  resources: [],
  mentionedBot: true,
};
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await flush();
  assert.ok(check());
}
for (const recovered of [true, false, 'throws'])
  test(`中断的部分卡片恢复${recovered === true ? '成功放行' : recovered === 'throws' ? '异常保留并发送诊断' : '失败保留'}队列且不重跑原任务`, async () => {
    const store = new GatewayStore(':memory:');
    store.acquireRuntimeLock();
    const replies: string[] = [];
    let runs = 0,
      recoveries = 0;
    const result = { terminal: 'idle' as const, messages: ['final'] };
    const gateway = new Gateway(
      store,
      {
        createSession: async () => 'session',
        run: async () => {
          runs++;
          return result;
        },
        inspectRun: async () => ({ status: 'ended', anchorEventId: 'a', terminalEventId: 'b', result }),
      },
      async (_m, out) => { if (out.type === 'text') replies.push(out.text); },
      {
        ...opts,
        reportDiagnostics: recovered === 'throws',
        streamReply: async (m, produce, observe) => {
          await produce(async () => {});
          await observe?.({ type: 'begin', mode: 'native_card' });
          await observe?.({ type: 'card_created', cardId: 'card', elementId: 'body' });
          await observe?.({ type: 'sending' });
          await observe?.({ type: 'sent', messageIds: ['reply'] });
          await observe?.({
            type: 'content_pending',
            sequence: 1,
            contentFingerprint: replyContentFingerprint('partial'),
          });
          throw Error('connection lost');
        },
        recoverReply: async (_m, request) => {
          recoveries++;
          assert.equal(request.content, 'final');
          assert.equal(request.cardId, 'card');
          if (recovered === 'throws') throw new Error('补发连接失败');
          return recovered === true
            ? {
                status: 'confirmed',
                messageId: request.messageId,
                elementId: request.elementId,
                contentFingerprint: request.contentFingerprint,
                observedAt: Date.now(),
              }
            : { status: 'unknown', reason: 'unavailable' };
        },
      },
    );
    try {
      gateway.accept(incoming);
      await until(() => store.inbox.findMessage(incoming)?.state === (recovered === true ? 'completed' : 'uncertain'));
      await flush();
      await gateway.reconcilePendingMessage(incoming);
      assert.equal(store.inbox.findMessage(incoming)?.state, recovered === true ? 'completed' : 'uncertain');
      assert.equal(runs, 1);
      assert.ok(recoveries >= 1);
      if (recovered === 'throws') assert.ok(replies.some(text => text.includes('回复补发核查')));
      if (recovered === true) {
        await gateway.reconcilePendingMessage(incoming);
        assert.equal(runs, 1);
        const next = { ...incoming, messageId: 'second', eventId: 'second', text: 'second' };
        gateway.accept(next);
        await until(() => store.inbox.findMessage(next)?.state === 'completed');
        assert.equal(runs, 2);
      }
    } finally {
      store.close();
    }
  });

test('排队消息已撤回则跳过，不调用 MA，后续有效消息继续', async () => {
  const store = new GatewayStore(':memory:');
  store.acquireRuntimeLock();
  let runs = 0;
  const gateway = new Gateway(
    store,
    {
      createSession: async () => 'session',
      run: async () => {
        runs++;
        return { terminal: 'idle', messages: ['done'] };
      },
    },
    async () => {},
    {
      ...opts,
      verifyQueuedMessages: true,
      readMessage: async (_m, id) => (id === 'first' ? { status: 'deleted' } : { status: 'unavailable' }),
    },
  );
  try {
    gateway.accept(incoming);
    const next = { ...incoming, messageId: 'second', eventId: 'second' };
    gateway.accept(next);
    await until(() => store.inbox.findMessage(next)?.state === 'completed');
    assert.equal(store.inbox.findMessage(incoming)?.state, 'failed');
    assert.equal(runs, 1);
  } finally {
    store.close();
  }
});
