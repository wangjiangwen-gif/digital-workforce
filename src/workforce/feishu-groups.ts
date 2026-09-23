import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DomainError } from './domain.ts';
import type { LocalWorkspace } from './workspace.ts';
import type { WorkspaceChannels } from './channels.ts';

type Run = (args: string[]) => Promise<any>;
const exec = promisify(execFile);
export const runLark: Run = async (args) => {
  let output: string;
  try {
    ({ stdout: output } = await exec('lark-cli', args, {
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    }));
  } catch (error) {
    // CLI 的非零退出也会在 stdout 返回结构化 API 错误；只解析 JSON，不暴露请求及凭证。
    const failed = error as { stdout?: string; killed?: boolean };
    if (!failed.killed && typeof failed.stdout === 'string' && failed.stdout.trim())
      return parseLarkResult(failed.stdout, true);
    throw new DomainError('飞书操作未完成，请检查本机 CLI 状态；如已发起添加，请先核查群成员再重试。', 502);
  }
  return parseLarkResult(output);
};

export function parseLarkResult(output: string, failed = false) {
  let result: any;
  try {
    result = JSON.parse(output);
  } catch {
    throw new DomainError('飞书返回数据无效', 502);
  }
  if (failed || result.ok === false || (result.code !== undefined && result.code !== 0)) {
    const code = result.error?.code ?? result.code;
    if (Number(code) === 232033)
      throw new DomainError(
        '此群为外部群，当前操作应用或被邀请机器人未获准执行外部群操作（飞书错误 232033）。请核查应用对外共享能力、可用范围及外部群限制后重试。',
        403,
      );
    const suffix = Number.isSafeInteger(Number(code)) ? `（飞书错误 ${Number(code)}）` : '';
    throw new DomainError(`飞书拒绝操作${suffix}，请检查当前用户权限及应用可用范围。`, 502);
  }
  return result.data ?? result;
}

export class FeishuGroups {
  private workspace: LocalWorkspace;
  private channels: Pick<WorkspaceChannels, 'view'>;
  private run: Run;
  constructor(workspace: LocalWorkspace, channels: Pick<WorkspaceChannels, 'view'>, run: Run = runLark) {
    this.workspace = workspace;
    this.channels = channels;
    this.run = run;
  }
  private async user() {
    const status = await this.run(['auth', 'status', '--json', '--verify']);
    const user = status.identities?.user;
    if (!user?.verified || !user.openId)
      throw new DomainError('请先在本机登录飞书 CLI 用户身份并授权群聊读取、成员管理权限。', 401);
    return user;
  }
  private call(args: string[]) {
    return this.run(['im', ...args, '--as', 'user', '--json']);
  }
  employees() {
    return this.workspace
      .read()
      .state.employees.filter(
        (employee: any) => employee.enabled && this.channels.view(employee.id).status === 'connected',
      )
      .map((employee: any) => ({ id: employee.id, name: employee.name }));
  }
  private async detail(chatId: string, userId: string) {
    if (!/^oc_[a-zA-Z0-9]+$/.test(chatId)) throw new DomainError('群聊 ID 无效');
    const chat = await this.call(['chats', 'get', '--chat-id', chatId, '--user-id-type', 'open_id']);
    const role =
      chat.owner_id === userId ? 'owner' : chat.user_manager_id_list?.includes(userId) ? 'manager' : '';
    if (!role || !['group', 'topic'].includes(chat.chat_mode) || chat.chat_status !== 'normal') return null;
    return { chatId, name: chat.name || '未命名群聊', role };
  }
  async list(pageToken = '') {
    if (pageToken.length > 4096) throw new DomainError('分页参数无效');
    const user = await this.user();
    const page = await this.call([
      '+chat-list',
      '--page-size',
      '100',
      '--sort',
      'active_time',
      ...(pageToken ? ['--page-token', pageToken] : []),
    ]);
    const groups: any[] = [];
    let failed = 0;
    // 限制并发，逐页校验管理员身份；失败的群不作为可操作群返回。
    const chats = page.chats || [];
    for (let i = 0; i < chats.length; i += 5) {
      const results = await Promise.allSettled(
        chats.slice(i, i + 5).map((chat: any) => this.detail(chat.chat_id, user.openId)),
      );
      for (const result of results) {
        if (result.status === 'rejected') failed++;
        else if (result.value) groups.push(result.value);
      }
    }
    return {
      groups,
      scanned: chats.length,
      failed,
      userName: user.userName,
      hasMore: Boolean(page.has_more),
      pageToken: page.page_token || '',
    };
  }
  async import(chatId: string, projectId?: string) {
    if (projectId !== undefined && !this.workspace.read().state.projects.some((p: any) => p.id === projectId))
      throw new DomainError('项目不存在', 404);
    const user = await this.user();
    const chat = await this.detail(chatId, user.openId);
    if (!chat) throw new DomainError('当前用户不是该群的群主或管理员，或群已解散。', 403);
    return this.persist(chat, undefined, projectId);
  }
  importManual(chatId: string, projectId: string) {
    const id = chatId.trim();
    if (!/^oc_[a-f0-9]{32}$/.test(id))
      throw new DomainError('请填写 oc_ 开头、后接 32 位小写十六进制字符的飞书群 Chat ID，不是群链接或群号');
    if (!projectId || !this.workspace.read().state.projects.some((p: any) => p.id === projectId))
      throw new DomainError('项目不存在', 404);
    const existing = this.workspace.read().state.groups.find((g: any) => g.chatId === id);
    return this.persist({ chatId: id, name: existing?.name || id }, undefined, projectId, 'manual');
  }
  async members(groupId: string, pageToken = '') {
    if (pageToken.length > 4096) throw new DomainError('分页参数无效');
    const group = this.workspace.read().state.groups.find((g: any) => g.id === groupId);
    if (!group) throw new DomainError('群聊不存在', 404);
    const user = await this.user();
    if (!(await this.detail(group.chatId, user.openId)))
      throw new DomainError('当前用户已无此群管理权限或群已解散。', 403);
    const page = await this.call([
      'chat.members',
      'get',
      '--chat-id',
      group.chatId,
      '--member-id-type',
      'open_id',
      '--page-size',
      '50',
      '--check-security-conf',
      ...(pageToken ? ['--page-token', pageToken] : []),
    ]);
    return {
      members: (page.items || []).map((member: any) => ({
        id: member.member_id,
        name: member.name || '未命名成员',
      })),
      hasMore: Boolean(page.has_more),
      pageToken: page.page_token || '',
      total: page.member_total,
      limited: Boolean(page.trigger_security_conf_limit),
    };
  }
  private persist(
    chat: { chatId: string; name: string },
    employeeId?: string,
    projectId?: string,
    source = 'feishu',
  ) {
    const latest = this.workspace.read();
    let group = latest.state.groups.find((g: any) => g.chatId === chat.chatId);
    if (!group) {
      group = { id: randomUUID(), ...chat, projectId: '', employeeIds: [], source };
      latest.state.groups.push(group);
    }
    if (projectId !== undefined) {
      if (!latest.state.projects.some((p: any) => p.id === projectId))
        throw new DomainError('项目不存在', 404);
      if (group.projectId && group.projectId !== projectId)
        throw new DomainError('该群已关联其他项目，请先解除关联', 409);
      group.projectId = projectId;
    }
    group.name = chat.name;
    group.source = source === 'manual' ? group.source || source : source;
    if (employeeId && !group.employeeIds.includes(employeeId)) group.employeeIds.push(employeeId);
    return this.workspace.save(latest.state, latest.revision);
  }
  async add(_chatId: string, _employeeId: string) {
    throw new DomainError('工作台仅查看，请在飞书中添加或移除机器人', 405);
  }

  projectGroup(projectId: string, groupId: string) {
    const state = this.workspace.read().state;
    const group = state.groups.find((g: any) => g.id === groupId && g.projectId === projectId);
    if (!group || !state.projects.some((p: any) => p.id === projectId))
      throw new DomainError('项目群聊不存在或关联已变化', 409);
    return group;
  }
  async invite(projectId: string, groupId: string, employeeId: string) {
    const group = this.projectGroup(projectId, groupId);
    const chatId = group.chatId;
    const employee = this.workspace.read().state.employees.find((e: any) => e.id === employeeId);
    if (!employee?.enabled) throw new DomainError('请选择已启用的数字员工');
    const binding = this.channels.view(employeeId);
    if (binding.status !== 'connected' || !binding.appId)
      throw new DomainError('请先完成该数字员工的飞书连接');
    const user = await this.user();
    const chat = await this.detail(chatId, user.openId);
    if (!chat) throw new DomainError('当前用户已无此群管理权限，无法添加数字员工。', 403);
    this.projectGroup(projectId, groupId);
    const result = await this.call([
      'chat.members',
      'create',
      '--chat-id',
      chatId,
      '--member-id-type',
      'app_id',
      '--succeed-type',
      '2',
      '--data',
      JSON.stringify({ id_list: [binding.appId] }),
    ]);
    if (result.pending_approval_id_list?.length)
      throw new DomainError('入群申请正在等待飞书审批，审批完成后通过进群事件同步。', 409);
    if (result.invalid_id_list?.length || result.not_existed_id_list?.length)
      throw new DomainError('机器人无法入群，请检查应用已发布且对当前用户可见。', 409);
    return this.persist(chat, employeeId);
  }
}
