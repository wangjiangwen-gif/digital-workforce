import { Gateway, type GatewayOptions } from "./gateway.ts";
import { EmployeeAuthorizationManager } from "./employee-auth.ts";
import { FeishuOAuth } from "./oauth.ts";
import type { ArkClient } from "./ark.ts";
import type { GatewayStore } from "./store.ts";
import type { ChannelAdapter, ChannelMessage } from "./channel.ts";

// CLI 和工作台共用同一份对话、授权与凭证生命周期装配。
export function createEmployeeRuntime(input: {
  store: GatewayStore; ark: ArkClient;
  channel: Pick<ChannelAdapter, "reply" | "download"> & Partial<ChannelAdapter>;
  config: { feishuAppId: string; feishuAppSecret: string; arkAgentId: string; arkEnvironmentId: string; arkVaultId: string; sessionTimeoutMs: number };
  sessionConfiguration?: GatewayOptions["sessionConfiguration"];
  buildSessionRequest?: GatewayOptions["buildSessionRequest"];
  sessionRequestReadOnly?: boolean;
  ensureBotToken: (allowCreate?: boolean) => Promise<void>;
  verifyQueuedMessages?: boolean;
  runtimeRevision?: string; durableQueue?: boolean; pdfInputMode?: "file" | "sandbox";
  businessHooks?: Pick<GatewayOptions, "beforeBusinessTurn" | "prepareBusinessInput" | "observeBusinessResult" | "afterBusinessTurn" | "validateBusinessSession" | "handleBusinessCommand">;
}) {
  const { store, ark, config, sessionConfiguration, ensureBotToken } = input;
  const runtimeRevision = input.runtimeRevision || "employee-runtime-v1";
  // 绑定 this，支持直接传入 ChannelAdapter 实例。
  const source = input.channel;
  const channel = {
    reply: source.reply.bind(source), download: source.download.bind(source),
    streamReply: source.streamReply?.bind(source), addReaction: source.addReaction?.bind(source),
    removeReaction: source.removeReaction?.bind(source), inspectReaction: source.inspectReaction?.bind(source),
    inspectReply: source.inspectReply?.bind(source), recoverReply: source.recoverReply?.bind(source), loadRecentHistory: source.loadRecentHistory?.bind(source),
    readMessage: source.readMessage?.bind(source),
  };
  const sendAuthorizationCard = async (message: ChannelMessage, url: string): Promise<void> => {
    const card = { schema: "2.0", config: { width_mode: "default" }, header: { title: { tag: "plain_text", content: "授权查看你的日程" }, subtitle: { tag: "plain_text", content: "用户日历权限授权" }, template: "blue", icon: { tag: "standard_icon", token: "calendar_outlined" } }, body: { elements: [{ tag: "markdown", content: "为了帮你避开冲突，数字员工需要读取你的日程和忙闲信息。创建日程仍使用数字员工的 Bot 身份，并会邀请你参加。\n\n可发送 `/auth cancel` 取消本次等待和任务续跑；这不会撤销已经授予的飞书权限。" }, { tag: "button", text: { tag: "plain_text", content: "授权查看日程" }, type: "primary_filled", width: "fill", behaviors: [{ type: "open_url", default_url: url }] }] } };
    await channel.reply(message, { type: "card", card });
  };
  let gateway: InstanceType<typeof Gateway>;
  const auth = new EmployeeAuthorizationManager(
    store,
    ark,
    new FeishuOAuth(config.feishuAppId, config.feishuAppSecret),
    sendAuthorizationCard,
    (message, userVaultId) => gateway.resumeAfterAuthorization(message, userVaultId),
    {
      notify: (message, text) => channel.reply(message, { type: "text", text }),
      onStateChange: (messages, flowId, active) => gateway.setAuthorizationWaiting(messages, flowId, active)
    }
  );
  gateway = new Gateway(store, ark, (message, outbound, observer) => channel.reply(message, outbound, observer), {
    reportDiagnostics: true,
    appId: config.feishuAppId, sessionConfiguration, buildSessionRequest: input.buildSessionRequest, sessionConfigurationRevision: runtimeRevision,
    sessionRequestReadOnly: input.sessionRequestReadOnly,
    pdfInputMode: input.pdfInputMode || "file",
    agentId: config.arkAgentId, environmentId: config.arkEnvironmentId, vaultId: config.arkVaultId,
    timeoutMs: config.sessionTimeoutMs, platformAccess: true, downloadAttachment: (resource, message, maxBytes) => channel.download(resource, message, maxBytes),
    streamReply: channel.streamReply, addReaction: channel.addReaction, removeReaction: channel.removeReaction,
    inspectReaction: channel.inspectReaction,
    inspectReply: channel.inspectReply, recoverReply: channel.recoverReply,
    verifyQueuedMessages: input.verifyQueuedMessages,
    ensureAuthorization: (message, request) => auth.ensure(message, request),
    cancelAuthorization: message => auth.cancel(message),
    authorizationStatus: message => auth.status(message),
    getUserVaultIds: message => message.conversationType === "direct" ? auth.vaultIds(message) : Promise.resolve([]),
    userCredentialLifecycle: {
      revision: "employee-credentials-v2",
      capture: message => auth.captureUserTurn(message),
      prepare: (message, intent) => auth.prepareUserTurn(message, intent),
      recover: async (message, intent) => {
        if (!auth.matchesUserTurnIntent(message, intent)) throw new Error("原用户授权准备意图已变化，未恢复旧任务");
        await ensureBotToken(false);
        return auth.recoverUserTurn(message, intent);
      },
      matchesIntent: (message, intent) => auth.matchesUserTurnIntent(message, intent),
      refresh: async (message, expected) => {
        if (!auth.matchesPreparedAuthorization(message, expected)) throw new Error("用户授权已变化，未恢复旧任务");
        await ensureBotToken(false);
        await auth.refreshPreparedAuthorization(message, expected);
      },
      matches: (message, expected, forDispatch) => auth.matchesPreparedAuthorization(message, expected, forDispatch)
    },
    beforeCreateSession: ensureBotToken, dualIdentity: true, sharedGroupSessions: true,
    sessionEnvironment: message => ({
      FEISHU_IDENTITY_MODE: message.conversationType === "group" ? "bot_only" : "bot_with_user_oauth",
      LARKSUITE_CLI_STRICT_MODE: message.conversationType === "group" ? "bot" : "off"
    }),
    loadRecentHistory: message => channel.loadRecentHistory?.(message) || Promise.resolve([]),
    readMessage: channel.readMessage,
    durableQueue: input.durableQueue,
    ...input.businessHooks
  });
  return { gateway, auth };
}
