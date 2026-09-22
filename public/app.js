// 工作台以服务端状态为准，不自动导入浏览器旧数据或演示数据。
const storageKey = 'workforce.frontend.v1';
const copy = (value) => structuredClone(value);
const uid = () => crypto.randomUUID();
const initialEmployee = (id, name, description) => ({
  id,
  name,
  description,
  enabled: true,
  identity: '',
  knowledge: '',
  rules: '',
  skills: [],
  memories: [],
  environment: { name: '默认环境', model: '待配置', region: '北京', timeout: 300 },
  credentials: [],
  channels: { feishu: { enabled: false, appId: '' }, doubao: { enabled: false, agentId: '' } },
  versions: [],
  activeVersion: null,
  updatedAt: '2026-09-21T09:00:00+08:00',
});
function snapshot(employee) {
  const { versions, activeVersion, memories, memoryStores, updatedAt, ...configuration } = employee;
  return copy(configuration);
}
function migrateMemories(state) {
  state.groups ||= state.projects.flatMap((project) =>
    project.groups.map((group) => ({
      ...group,
      id: `${project.id}:${group.id}`,
      projectId: project.id,
      employeeIds: group.employeeIds || (group.employeeId ? [group.employeeId] : []),
      source: 'project',
    })),
  );
  syncProjectGroups(state);
  for (const project of state.projects)
    project.employees ||= [...new Set(project.groups.flatMap((g) => g.employeeIds))].map((id) => ({
      id,
      role: '',
      permission: 'write',
    }));
  state.tasks ||= initialTasks();
  for (const owner of [...state.employees, ...state.projects]) {
    owner.memoryStores ||= [{ id: 'default', name: '默认记忆库', description: '' }];
    owner.memories.forEach((entry) => {
      entry.storeId ||= owner.memoryStores[0].id;
      entry.path ||= `notes/${entry.id}.md`;
    });
  }
  return state;
}
function syncProjectGroups(state) {
  for (const project of state.projects)
    project.groups = state.groups
      .filter((group) => group.projectId === project.id)
      .map((group) => ({ ...group, employeeId: group.employeeIds[0] || '' }));
}
function initialTasks() {
  return [
    {
      id: 'task-strategy',
      name: '整理上市传播建议',
      type: 'run',
      status: 'running',
      employeeId: 'brand',
      projectId: 'launch',
      progress: '正在整理策略建议',
      detail: '根据项目 Brief 和已确认的项目记忆，整理传播方向与执行建议。',
      steps: ['已完成 · 读取项目上下文', '进行中 · 整理策略建议', '待执行 · 生成交付内容'],
    },
    {
      id: 'task-memory',
      name: '整理项目会议共识',
      type: 'memory',
      status: 'running',
      employeeId: 'brand',
      projectId: 'launch',
      progress: '正在提炼已确认的共识',
      detail: '整理会议中的已确认内容，准备更新项目记忆条目。',
      steps: ['已完成 · 整理会议内容', '进行中 · 提炼项目共识', '待执行 · 更新记忆条目'],
    },
    {
      id: 'task-content',
      name: '生成上市内容初稿',
      type: 'run',
      status: 'queued',
      employeeId: 'content',
      projectId: 'launch',
      progress: '等待策略建议完成',
      detail: '策略建议完成后，生成上市传播内容初稿。',
      steps: ['等待中 · 策略建议', '待执行 · 撰写内容初稿'],
    },
  ];
}
function activeTasks(tasks) {
  return tasks.filter((task) => task.status === 'running' || task.status === 'queued');
}
function memoryTree(entries) {
  const root = { folders: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push({ ...entry, filename: parts.at(-1) });
  }
  return root;
}
function memoryError(owner, values, id) {
  if (!owner.memoryStores.some((store) => store.id === values.storeId)) return '请选择记忆库';
  if (
    !values.path ||
    /[\\\\\x00-\x1f]/.test(values.path) ||
    values.path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return '请填写有效的相对路径，例如 notes/brief.md';
  if (!values.content.trim()) return '请填写文本内容';
  if (
    owner.memories.some(
      (entry) => entry.id !== id && entry.storeId === values.storeId && entry.path === values.path,
    )
  )
    return '该记忆库中已存在相同路径的条目';
  return '';
}
function seed() {
  const strategist = initialEmployee('brand', '品牌策略顾问', '从 Brief 到策略方案，协助团队对齐品牌方向。');
  strategist.identity =
    '你是一位品牌策略顾问，负责分析客户 Brief、梳理品牌定位与传播策略。清楚区分已确认决策与讨论建议。';
  strategist.knowledge = '品牌策略方法\n从目标人群、核心价值、竞争差异三个维度形成策略。';
  strategist.rules = '对外发布前需取得负责人确认。\n不要将项目敏感信息用于其他项目。';
  strategist.skills = [
    { id: 'brief', name: 'Brief 分析', description: '提取业务目标、受众与交付要求', enabled: true },
    { id: 'research', name: '资料整理', description: '整理信息与可追溯来源', enabled: true },
  ];
  strategist.memories = [
    {
      id: 'em1',
      title: '输出偏好',
      content: '策略建议先给结论，再给依据和可执行动作。',
      updatedAt: '2026-09-21T09:00:00+08:00',
    },
  ];
  strategist.environment = { name: '策略协作环境', model: '由 MA 环境提供', region: '北京', timeout: 300 };
  strategist.channels.feishu = { enabled: true, appId: 'cli_demo_brand' };
  strategist.versions = [
    {
      id: 'v1',
      number: 1,
      note: '初始配置',
      createdAt: '2026-09-21T09:00:00+08:00',
      snapshot: snapshot(strategist),
    },
  ];
  strategist.activeVersion = 'v1';
  return {
    employees: [
      strategist,
      initialEmployee('content', '内容创意助手', '协助构思创意、撰写内容与检查表达一致性。'),
    ],
    projects: [
      {
        id: 'launch',
        name: '秋季品牌上市',
        description: '统筹上市传播，沉淀团队共识与项目资料。',
        memories: [
          {
            id: 'pm1',
            title: '上市传播方向',
            content: '以真实用户场景为核心，优先呈现产品的日常使用价值。',
            source: '品牌项目群 · 已确认讨论',
            updatedAt: '2026-09-21T09:15:00+08:00',
          },
        ],
        groups: [
          { id: 'g1', name: '品牌项目群', chatId: 'oc_demo_brand', employeeId: 'brand' },
          { id: 'g2', name: '内容协作群', chatId: 'oc_demo_content', employeeId: 'content' },
        ],
        members: [
          { id: 'm1', name: '项目负责人', account: 'owner@example.com', permission: 'manage' },
          { id: 'm2', name: '内容协作者', account: 'editor@example.com', permission: 'write' },
          { id: 'm3', name: '项目观察员', account: 'viewer@example.com', permission: 'read' },
        ],
      },
    ],
    observations: [
      {
        id: 'run1',
        name: '整理上市传播建议',
        type: 'run',
        status: 'completed',
        employeeId: 'brand',
        projectId: 'launch',
        time: '2026-09-21T09:15:00+08:00',
        duration: '12 秒',
        detail: '已读取项目上下文，生成传播建议。此记录为演示数据。',
        steps: ['接收群聊请求', '加载员工配置与项目记忆', 'MA 执行完成', '回复群聊'],
      },
      {
        id: 'memory1',
        name: '更新项目共识',
        type: 'memory',
        status: 'completed',
        employeeId: 'brand',
        projectId: 'launch',
        time: '2026-09-21T09:16:00+08:00',
        duration: '3 秒',
        detail: '从已确认讨论中整理 1 条项目记忆。此记录为演示数据。',
        steps: ['会话进入空闲', '提炼确认内容', '更新项目记忆'],
      },
      {
        id: 'run2',
        name: '内容渠道连接检查',
        type: 'run',
        status: 'failed',
        employeeId: 'content',
        projectId: '',
        time: '2026-09-21T09:20:00+08:00',
        duration: '1 秒',
        detail: '演示异常：尚未配置渠道标识，请在员工详情中检查渠道配置。',
        steps: ['读取渠道配置', '渠道标识缺失，结束检查'],
      },
    ],
  };
}
const repository = {
  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved && ['employees', 'projects', 'observations'].every((key) => Array.isArray(saved[key])))
        return migrateMemories(saved);
    } catch {
      /* 浏览器存储不可用时保留当前会话演示。 */
    }
    return migrateMemories(seed());
  },
  save(next) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  },
};
let data = repository.load();
let serverRevision = 0;
let confirmedData = null;
let connected = false;
let saving = false;
async function request(path, method = 'GET', body) {
  const response = await fetch('/api/workspace' + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(
      path.startsWith('/employee-templates/') ||
        path.startsWith('/feishu-groups') ||
        /^\/projects\/[^/]+\/groups\/[^/]+\/employees$/.test(path)
        ? 180000
        : 15000,
    ),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本机服务请求失败');
  return result;
}
function acceptServer(result) {
  loadedMemoryKey = '';
  serverRevision = result.revision;
  data = migrateMemories(result.state);
  confirmedData = copy(data);
}
async function connectWorkspace() {
  $('#content').innerHTML = '<div class="empty">正在连接本机服务…</div>';
  try {
    let result = await request('');
    if (!result.initialized) {
      const initial = migrateMemories(result.state);
      initial.tasks = [];
      try {
        result = await request('', 'PUT', { revision: 0, state: initial });
      } catch (error) {
        result = await request('');
        if (!result.initialized) throw error;
      }
    }
    acceptServer(result);
    connected = true;
    $('#workspace-status').textContent = '本机服务已连接';
    $('#workspace-status').className = 'pill green';
    void refreshMaStatus();
    render();
  } catch (error) {
    connected = false;
    $('#workspace-status').textContent = '本机服务未连接';
    $('#workspace-status').className = 'pill red';
    paintMaStatus(null);
    $('#content').innerHTML =
      empty('无法连接本机工作台', esc(error.message)) + button('重试连接', 'reconnect', '', true);
  }
}
let search = '',
  statusFilter = 'all',
  typeFilter = 'all',
  dirty = false;
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const date = (value) =>
  new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
const names = { employees: '数字员工', projects: '项目', tasks: '运行中的任务', groups: '群聊' };
const employeeTabs = {
  basic: '基础信息',
  identity: '身份',
  knowledge: '知识与规则',
  skills: '技能',
  memories: '记忆',
  environment: '环境',
  credentials: '凭证',
  channels: '飞书及豆包',
  versions: '版本控制',
};
const projectTabs = {
  memories: '项目记忆',
  groups: '关联群聊',
};
function route() {
  const [module = 'employees', id, section] = location.hash.slice(1).split('/');
  return { module: names[module] ? module : 'employees', id, section };
}
const employeeName = (id) => data.employees.find((item) => item.id === id)?.name || '未关联员工';
const projectName = (id) => data.projects.find((item) => item.id === id)?.name || '无项目';
const button = (label, action, id = '', primary = false) =>
  `<button type="button" data-action="${action}" data-id="${esc(id)}" class="${primary ? 'primary' : ''}">${label}</button>`;
const badge = (label, style = '') => `<span class="pill ${style}">${esc(label)}</span>`;
const field = (label, name, value = '', placeholder = '', required = false) =>
  `<label>${label}<input name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''} maxlength="500" /></label>`;
const area = (label, name, value = '', rows = 7) =>
  `<label>${label}<textarea name="${name}" rows="${rows}" maxlength="30000">${esc(value)}</textarea></label>`;
let selectCounter = 0;
const select = (label, name, value, options) => {
  const id = `select-${++selectCounter}`;
  const selected = options.find(([key]) => key === value) || options[0];
  return `<label class="select-field" for="${id}"><span id="${id}-label">${esc(label)}</span><span class="ui-select"><input type="hidden" name="${esc(name)}" value="${esc(selected?.[0] || '')}" /><button type="button" id="${id}" class="select-trigger" role="combobox" aria-labelledby="${id}-label" aria-expanded="false" aria-haspopup="listbox" aria-controls="${id}-list" ${!options.length ? 'disabled' : ''}><span class="select-value">${esc(selected?.[1] || '暂无选项')}</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m8 9 4-4 4 4M8 15l4 4 4-4"/></svg></button><span id="${id}-list" class="select-menu" role="listbox" aria-labelledby="${id}-label" popover="auto">${options.map(([key, text], index) => `<span id="${id}-option-${index}" class="select-option" role="option" aria-selected="${key === selected?.[0]}" data-value="${esc(key)}"><span>${esc(text)}</span><span class="select-check" aria-hidden="true">✓</span></span>`).join('')}</span></span></label>`;
};
function openSelect(trigger) {
  const menu = document.getElementById(trigger.getAttribute('aria-controls'));
  if (menu.matches(':popover-open')) {
    menu.hidePopover();
    return;
  }
  menu.showPopover();
  const rect = trigger.getBoundingClientRect();
  menu.style.width = Math.min(rect.width, innerWidth - 16) + 'px';
  menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)) + 'px';
  const below = innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const upwards = below < Math.min(menu.scrollHeight, 240) && above > below;
  menu.style.maxHeight = Math.max(60, Math.min(280, upwards ? above : below)) + 'px';
  menu.style.top = (upwards ? Math.max(8, rect.top - menu.offsetHeight - 5) : rect.bottom + 5) + 'px';
  trigger.setAttribute('aria-expanded', 'true');
  const selected = menu.querySelector('[aria-selected="true"]') || menu.firstElementChild;
  focusSelectOption(trigger, selected);
  menu.ontoggle = () => {
    const open = menu.matches(':popover-open');
    trigger.setAttribute('aria-expanded', String(open));
    if (!open) trigger.removeAttribute('aria-activedescendant');
  };
}
function focusSelectOption(trigger, option) {
  if (!option) return;
  const menu = option.parentElement;
  menu
    .querySelectorAll('.select-option')
    .forEach((item) => item.classList.toggle('highlighted', item === option));
  trigger.setAttribute('aria-activedescendant', option.id);
  option.scrollIntoView({ block: 'nearest' });
}
function chooseSelectOption(option) {
  const wrapper = option.closest('.ui-select');
  const input = wrapper.querySelector('input');
  const trigger = wrapper.querySelector('.select-trigger');
  input.value = option.dataset.value;
  trigger.querySelector('.select-value').textContent = option.firstElementChild.textContent;
  option.parentElement
    .querySelectorAll('[role="option"]')
    .forEach((item) => item.setAttribute('aria-selected', String(item === option)));
  option.parentElement.hidePopover();
  trigger.setAttribute('aria-expanded', 'false');
  trigger.removeAttribute('aria-activedescendant');
  trigger.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function closeSelectMenus() {
  document.querySelectorAll('.select-menu:popover-open').forEach((menu) => menu.hidePopover());
}
window.addEventListener('resize', closeSelectMenus);
document.addEventListener(
  'scroll',
  (event) => {
    if (!event.target.closest?.('.select-menu')) closeSelectMenus();
  },
  true,
);
document.addEventListener('click', (event) => {
  const option = event.target.closest('.select-option');
  const trigger = event.target.closest('.select-trigger');
  if (option) {
    event.preventDefault();
    chooseSelectOption(option);
  } else if (trigger) {
    event.preventDefault();
    openSelect(trigger);
  }
});
document.addEventListener('keydown', (event) => {
  const trigger = event.target.closest('.select-trigger');
  if (!trigger) return;
  const menu = document.getElementById(trigger.getAttribute('aria-controls'));
  const open = menu.matches(':popover-open');
  if (event.key === 'Tab' || event.key === 'Escape') {
    if (open) {
      menu.hidePopover();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  if (!open) {
    openSelect(trigger);
    return;
  }
  const options = [...menu.children];
  const current = options.findIndex((item) => item.id === trigger.getAttribute('aria-activedescendant'));
  if (event.key === 'Enter' || event.key === ' ') return chooseSelectOption(options[Math.max(0, current)]);
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  focusSelectOption(trigger, options[index]);
});
// 全局使用同一套描边图形，角色色按标识稳定分配。
const iconPaths = {
  employees:
    '<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 12v2m8-2v2M9 17h6M1 12v4m22-4v4"/>',
  projects:
    '<path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z"/><path d="M3 10h18"/>',
  groups: '<path d="M20 11a8 8 0 0 1-8 8H8l-5 3 1-6a8 8 0 1 1 16-5Z"/><path d="M8 10h8M8 14h5"/>',
  tasks: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  memory: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/>',
  skill: '<path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3Z"/>',
  credential: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  empty: '<path d="m4 8 8-4 8 4v10l-8 4-8-4Z M4 8l8 4 8-4M12 12v10"/>',
};
const uiIcon = (kind) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[kind] || iconPaths.empty}</svg>`;
const entityMark = (kind, key = '') => {
  const tone = [...String(key)].reduce((sum, ch) => sum + ch.codePointAt(0), 0) % 4;
  return `<span class="entity-icon tone-${tone}" aria-hidden="true">${uiIcon(kind)}</span>`;
};
const panel = (heading, description, body) =>
  `<section class="panel"><h3>${heading}</h3>${description ? `<p class="muted">${description}</p>` : ''}${body}</section>`;
const empty = (title, description) =>
  `<div class="empty"><div class="symbol">${uiIcon('empty')}</div><h3>${title}</h3><p>${description}</p></div>`;
const head = (title, description, action = '') =>
  `<div class="page-head"><div class="page-title-group">${entityMark(route().module, title)}<div><h1>${esc(title)}</h1><p>${esc(description)}</p></div></div><div class="actions">${action}</div></div>`;
const saveBar = () =>
  '<div class="actions form-actions"><small id="save-state">配置保存到本机 SQLite</small><button class="primary" type="submit">保存配置</button></div>';
function toast(message) {
  if ($('#modal').open && $('#dialog-feedback')) {
    $('#dialog-feedback').textContent = message;
    return;
  }
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 3500);
}
async function commit(message) {
  if (saving || !connected) return;
  saving = true;
  $('#app').inert = true;
  $('#modal').inert = true;
  const pending = copy(migrateMemories(data));
  for (const owner of [...pending.employees, ...pending.projects])
    if (owner.memoryMode === 'ma') owner.memories = [];
  try {
    const result = await request('', 'PUT', { revision: serverRevision, state: pending });
    acceptServer(result);
    dirty = false;
    render();
    toast(message === '已保存' ? '已保存到本机' : message + '，已保存到本机');
    return true;
  } catch (error) {
    let backup = false;
    try {
      localStorage.setItem('workforce.unsaved-backup', JSON.stringify(pending));
      backup = true;
    } catch {
      /* 存储失败时仍明确提示未保存。 */
    }
    try {
      acceptServer(await request(''));
    } catch {
      data = copy(confirmedData);
    }
    dirty = false;
    render();
    toast(
      `保存失败：${error.message}。${backup ? '未保存修改已留存浏览器备份 workforce.unsaved-backup。' : '未保存修改无法备份，请重新编辑。'}`,
    );
  } finally {
    saving = false;
    $('#app').inert = false;
    $('#modal').inert = false;
  }
}
function modal(title, body) {
  $('#modal-content').innerHTML =
    `<h2 id="modal-title">${esc(title)}</h2>${body}<p id="dialog-feedback" class="error" role="alert"></p>`;
  $('#modal').showModal();
}
function closeModal() {
  maSkillGeneration++;
  groupLoadGeneration++;
  const secret = $('#ma-api-key');
  if (secret) secret.value = '';
  $('#modal').close();
}
function paintMaStatus(state) {
  const status = $('#ma-status');
  if (!status) return;
  const verified = state?.configured && state?.connected === true;
  status.className = `pill${verified ? ' green' : state?.verification === 'failed' ? ' red' : state?.configured ? ' amber' : ''}`;
  status.textContent = !state
    ? '方舟状态读取失败'
    : verified
      ? '方舟服务已连接'
      : state.verification === 'failed'
        ? '方舟连接验证失败'
        : state.configured
          ? '方舟已配置 · 待验证'
          : '方舟未配置';
  status.title = state?.message || '打开方舟配置查看详情';
}
async function refreshMaStatus() {
  try {
    paintMaStatus(await request('/ma-config'));
  } catch {
    paintMaStatus(null);
  }
}
let maInitializationTimer;
async function initializeMaResources() {
  const input = $('#ma-api-key');
  if (input?.value.trim()) return toast('请先保存并验证新密钥，再初始化资源');
  const host = $('#ma-initialization-status');
  const paint = (state) => {
    if (!host?.isConnected) return;
    const task = state.task;
    host.innerHTML = task
      ? `<p><b>${esc(task.progress)}</b></p>${(task.steps || []).map((step) => `<p class="muted">${esc(step)}</p>`).join('')}${(task.warnings || []).map((warning) => `<p>${esc(warning)}</p>`).join('')}`
      : '';
    if (state.running) maInitializationTimer = setTimeout(poll, 2000);
    else
      void request('')
        .then(acceptServer)
        .catch(() => {});
  };
  const poll = async () => {
    if (!host?.isConnected) return;
    try {
      paint(await request('/ma-config/initialize'));
    } catch (error) {
      host.textContent = error.message;
    }
  };
  clearTimeout(maInitializationTimer);
  try {
    paint(await request('/ma-config/initialize', 'POST', {}));
  } catch (error) {
    if (host) host.textContent = error.message;
  }
}
async function openMaConfig() {
  try {
    const state = await request('/ma-config');
    paintMaStatus(state);
    modal(
      '方舟配置',
      `<p>${state.configured ? `已配置 · ${esc(state.source)}` : '尚未配置可用的 API Key'}</p>
      <p class="muted">用于数字员工调用方舟 MA。密钥仅保存到本机后端，不回显、不写入浏览器存储。页面配置优先于环境变量。</p>
      <form id="ma-config-form" autocomplete="off"><label for="ma-api-key">方舟 API Key</label>
      <input id="ma-api-key" type="password" name="apiKey" autocomplete="new-password" maxlength="4096" required placeholder="${state.configured ? '输入新密钥以替换；留空不修改' : '输入具备 MA 权限的 API Key'}" />
      <p id="ma-verification-message" class="muted" role="status">${esc(state.message)}</p>
      <p class="muted">初始化会核验并补齐已有 ADA / 社媒热点员工的配套技能、环境、记忆库、Agent 与 Bot 凭证。已存在的资源会复用；已删除且无备份的记忆只能重建空库。初始化会暂停飞书 Channel，完成后需重启本机服务并发送 /new。</p><div id="ma-initialization-status" role="status"></div>
      <div class="actions form-actions">${button('取消', 'close')}${state.configured ? button('重新验证已保存密钥', 'verify-ma') + button('一键初始化 MA 资源', 'initialize-ma') : ''}<button class="primary" type="submit">保存并验证</button></div></form>`,
    );
  } catch (error) {
    toast(error.message);
  }
}
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'ma-config-form') return;
  event.preventDefault();
  const form = event.target;
  const keyInput = form.elements.apiKey;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  const verifyButton = form.querySelector('[data-action="verify-ma"]');
  if (verifyButton) verifyButton.disabled = true;
  $('#ma-status').textContent = '正在保存并验证方舟连接…';
  $('#ma-status').className = 'pill';
  try {
    const state = await request('/ma-config', 'PUT', { apiKey: keyInput.value });
    paintMaStatus(state);
    keyInput.value = '';
    if (state.connected) {
      closeModal();
      toast('方舟服务已连接');
    } else {
      $('#ma-verification-message').textContent = `密钥已保存。${state.message}`;
      if (!verifyButton) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.dataset.action = 'verify-ma';
        retry.textContent = '重新验证已保存密钥';
        submit.before(retry);
      }
    }
  } catch (error) {
    keyInput.value = '';
    toast(error.message);
    void refreshMaStatus();
  } finally {
    submit.disabled = false;
    if (verifyButton) verifyButton.disabled = false;
  }
});
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action="verify-ma"]');
  if (!target) return;
  const form = $('#ma-config-form');
  const submit = form.querySelector('[type="submit"]');
  target.disabled = submit.disabled = true;
  $('#ma-status').textContent = '正在验证方舟连接…';
  $('#ma-status').className = 'pill';
  const feedback = $('#ma-verification-message');
  feedback.textContent = '正在验证已保存密钥的 MA 只读访问权限…';
  try {
    const state = await request('/ma-config/verify', 'POST', {});
    paintMaStatus(state);
    feedback.textContent = state.message;
  } catch (error) {
    feedback.textContent = error.message;
    void refreshMaStatus();
  } finally {
    target.disabled = submit.disabled = false;
  }
});
let feishuPoll;
let feishuDialogId;
function chooseFeishu(id) {
  modal(
    '接入飞书',
    `<p class="muted">选择此数字员工使用的飞书应用。</p><div class="actions">${button('新建飞书应用', 'create-feishu', '', true)}${button('使用已有应用', 'existing-feishu')}</div><div class="actions form-actions">${button('取消', 'close')}</div>`,
  );
  feishuDialogId = id;
}
function existingFeishu(id) {
  clearTimeout(feishuPoll);
  feishuDialogId = id;
  modal(
    '使用已有飞书应用',
    `<form id="existing-feishu-form">
    <p class="muted">填写企业自建应用凭证。接入后会校验权限并启动机器人连接；同一应用只能绑定一个数字员工。</p>
    <label>App ID<input name="appId" placeholder="cli_…" required autocomplete="off"></label>
    <label>App Secret<input name="appSecret" type="password" required autocomplete="new-password"></label>
    <p class="muted">请在飞书开放平台启用机器人、配置长连接与消息/机器人进退群事件，并发布应用。若已有其他服务使用此机器人，请先停止原服务。</p>
    <p id="existing-feishu-error" class="error" role="alert"></p>
    <div class="actions form-actions">${button('取消', 'close')}<button class="primary" type="submit">验证并接入</button></div></form>`,
  );
}
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'existing-feishu-form') return;
  event.preventDefault();
  const form = event.target,
    id = feishuDialogId,
    submit = form.querySelector('[type="submit"]');
  const data = new FormData(form);
  submit.disabled = true;
  try {
    await request(`/employees/${encodeURIComponent(id)}/feishu`, 'POST', {
      mode: 'existing',
      appId: data.get('appId'),
      appSecret: data.get('appSecret'),
    });
    form.elements.appSecret.value = '';
    if ($('#modal').open && feishuDialogId === id && $('#existing-feishu-form') === form)
      await openFeishu(id);
  } catch (error) {
    form.elements.appSecret.value = '';
    form.querySelector('#existing-feishu-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
async function openFeishu(id, begin = false, confirmedNotCreated = false, upgrade = false) {
  clearTimeout(feishuPoll);
  feishuDialogId = id;
  modal(
    '接入飞书',
    '<div id="feishu-progress">正在读取接入状态…</div><div class="actions form-actions">' +
      button('关闭', 'close') +
      '</div>',
  );
  try {
    const state = await request(
      `/employees/${encodeURIComponent(id)}/feishu${upgrade ? '/upgrade' : ''}`,
      begin ? 'POST' : 'GET',
      begin ? { confirmedNotCreated } : undefined,
    );
    paintFeishu(id, state);
  } catch (error) {
    if ($('#feishu-progress')) {
      try {
        paintFeishu(id, await request(`/employees/${encodeURIComponent(id)}/feishu`));
      } catch {
        $('#feishu-progress').textContent = error.message;
      }
    }
  }
}
function paintFeishu(id, state) {
  if (!$('#modal').open || feishuDialogId !== id || !$('#feishu-progress')) return;
  $('#feishu-progress').innerHTML = `<p role="status">${esc(state.message || state.status)}</p>
    ${state.groupEventsAuthorized === false ? `<p class="error" role="alert">缺少机器人进退群事件权限，移除机器人后工作台无法自动同步。请在飞书开放平台开通「订阅机器人进、出群事件」并确认订阅进群、退群事件，发布应用后重启本机服务。</p><p><a href="https://open.feishu.cn/app/${encodeURIComponent(state.appId)}/auth" target="_blank" rel="noopener noreferrer">前往飞书配置权限 ↗</a></p>` : ''}
    ${state.permissionWarnings?.length ? `<p class="muted">原权限模板尚未授予：${state.permissionWarnings.map(esc).join('、')}。相关业务操作以飞书实际权限为准，不影响已具备权限的卡片对话。</p>` : ''}
    ${state.status === 'awaiting_permissions' ? button('补齐现有应用权限', 'upgrade-feishu', id, true) : ''}
    ${state.appId && ['stopped', 'awaiting_ma', 'error'].includes(state.status) ? button('继续接入', 'resume-feishu', id, true) : ''}
    ${!state.appId && ['error', 'interrupted'].includes(state.status) ? `<p>若已创建应用，请保留现有应用并联系接入人员核对绑定。</p>${button('我确认尚未创建，重新生成二维码', 'retry-feishu', id, true)}` : ''}
    ${state.appId ? `<p>App ID：${esc(state.appId)}</p>` : ''}
    ${state.url ? `<canvas id="feishu-qr" aria-label="使用飞书扫描创建应用" role="img"></canvas><p><a href="${esc(state.url)}" target="_blank" rel="noopener noreferrer">${esc(state.url)}</a></p><small>请使用当前账号确认。链接失效时请先核查飞书应用创建结果。</small>` : ''}
    ${state.lastReceivedAt ? `<p>最近收到消息：${esc(new Date(state.lastReceivedAt).toLocaleString())}</p>` : ''}
    ${state.lastRepliedAt ? `<p>最近成功回复：${esc(new Date(state.lastRepliedAt).toLocaleString())}</p>` : ''}
    ${state.status === 'connected' ? '<p>先与机器人单聊测试。群聊中使用前，请将机器人加入群，并在「群聊」中关联此员工后 @机器人。</p>' : ''}`;
  if (state.qr) {
    const canvas = $('#feishu-qr'),
      scale = 4,
      size = state.qr.length;
    canvas.width = canvas.height = (size + 8) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111';
    state.qr.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) ctx.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
      }),
    );
  }
  if (
    !['error', 'interrupted', 'unbound', 'awaiting_ma', 'awaiting_permissions', 'stopped'].includes(
      state.status,
    )
  )
    feishuPoll = setTimeout(async () => {
      if (!$('#modal').open || !$('#feishu-progress') || feishuDialogId !== id) return;
      try {
        paintFeishu(id, await request(`/employees/${encodeURIComponent(id)}/feishu`));
      } catch {
        if ($('#feishu-progress')) $('#feishu-progress').textContent = '状态读取失败，请关闭后重新查看';
      }
    }, 2000);
}
function tabs(module, id, items, active) {
  return `<nav class="detail-tabs" aria-label="详情导航">${Object.entries(items)
    .map(
      ([key, label]) =>
        `<a href="#${module}/${id}/${key}" class="${active === key ? 'active' : ''}" ${active === key ? 'aria-current="page"' : ''}>${label}</a>`,
    )
    .join('')}</nav>`;
}
function render() {
  if (!connected) return;
  const { module, id, section } = route();
  document.querySelectorAll('[data-nav]').forEach((link) => {
    link.classList.toggle('active', link.dataset.nav === module);
    if (link.dataset.nav === module) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#breadcrumb').textContent = `工作空间 / ${names[module]}`;
  if (module === 'employees' && id) {
    const employee = data.employees.find((item) => item.id === id);
    $('#content').innerHTML = employee
      ? employeeDetail(employee, employeeTabs[section] ? section : 'basic')
      : empty('员工不存在', '请从数字员工列表重新选择。');
  } else if (module === 'groups' && id) {
    const group = data.groups.find((item) => item.id === id);
    $('#content').innerHTML = group
      ? groupDetail(group, ['info', 'employees', 'members'].includes(section) ? section : 'info')
      : empty('群聊不存在', '请从群聊列表重新选择。');
    if (group && section === 'members') void loadGroupMembers(group.id);
  } else if (module === 'projects' && id) {
    const project = data.projects.find((item) => item.id === id);
    $('#content').innerHTML = project
      ? projectDetail(project, projectTabs[section] ? section : 'memories')
      : empty('项目不存在', '请从项目列表重新选择。');
  } else {
    $('#content').innerHTML =
      module === 'tasks' ? runningTasks() : module === 'groups' ? groupsOverview() : overview(module);
  }
  applyFilters();
}
let maSkillEmployee = '';
let maSkills = [];
let maSkillGeneration = 0;
async function browseMaSkills(employeeId) {
  const generation = ++maSkillGeneration;
  maSkillEmployee = employeeId;
  maSkills = [];
  modal('从 MA 添加技能', '<p>正在通过方舟 APIKey 读取 MA 技能…</p>');
  try {
    const result = await request('/ma-skills');
    if (generation !== maSkillGeneration || !$('#modal').open) return;
    for (const skill of result.skills) if (!maSkills.some((s) => s.id === skill.id)) maSkills.push(skill);
    const bound = data.employees.find((e) => e.id === employeeId)?.skills || [];
    modal(
      '从 MA 添加技能',
      `<p class="muted">本平台可用技能 ${maSkills.length} 项 · 来自 MA</p><input id="ma-skill-search" class="search" placeholder="搜索名称、描述或标签（如 ada）" aria-label="搜索 MA 技能" /><div class="grid compact-cards">${maSkills.map((s) => `<article class="entity-card" data-ma-skill-search="${esc((s.name + ' ' + s.description + ' ' + (s.tags || []).join(' ')).toLowerCase())}"><h3>${esc(s.name)}</h3><p class="card-description">${esc(s.description)}</p><p class="muted">${esc(s.id)} · v${esc(s.version)} ${esc((s.tags || []).join(' · '))}</p>${bound.some((b) => b.id === s.id && b.version === s.version) ? '<span class="pill green">已绑定</span>' : button('绑定此技能', 'bind-ma-skill', s.id, true)}</article>`).join('')}</div>${maSkills.length ? '' : '<p>本地清单暂无可用技能。</p>'}<div class="actions">${button('关闭', 'close')}</div>`,
    );
  } catch (error) {
    if (generation === maSkillGeneration && $('#modal').open)
      modal('从 MA 添加技能', `<p class="error">${esc(error.message)}</p>${button('关闭', 'close')}`);
  }
}
document.addEventListener('input', (event) => {
  if (event.target.id === 'environment-search') {
    const current = $('#employee-form').elements.maEnvironmentId.value;
    $('#environment-select').innerHTML = environmentSelect(
      environmentChoices.get(route().id),
      current,
      event.target.value,
    );
    return;
  }
  if (event.target.id !== 'ma-skill-search') return;
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll('[data-ma-skill-search]').forEach((card) => {
    card.hidden = !card.dataset.maSkillSearch.includes(query);
  });
});
let feishuGroupPage = '';
let feishuGroupsFound = [];
let feishuScanned = 0;
let feishuFailed = 0;
let groupLoadGeneration = 0;
async function browseFeishuGroups(more = false) {
  const generation = ++groupLoadGeneration;
  if (!more) {
    feishuGroupPage = '';
    feishuGroupsFound = [];
    feishuScanned = 0;
    feishuFailed = 0;
    modal('从飞书选择群聊', '<p>正在读取当前用户管理的群聊…</p>');
  }
  const content = $('#modal-content');
  content.querySelectorAll('button').forEach((button) => (button.disabled = true));
  try {
    const page = await request('/feishu-groups?pageToken=' + encodeURIComponent(feishuGroupPage));
    if (generation !== groupLoadGeneration || !$('#modal').open) return;
    feishuGroupPage = page.pageToken;
    feishuScanned += page.scanned;
    feishuFailed += page.failed;
    for (const group of page.groups)
      if (!feishuGroupsFound.some((g) => g.chatId === group.chatId)) feishuGroupsFound.push(group);
    modal(
      '从飞书选择群聊',
      `<p class="muted">${esc(page.userName || '当前用户')} · 已检查 ${feishuScanned} 个群，找到 ${feishuGroupsFound.length} 个管理群</p>${feishuFailed ? `<p class="error">${feishuFailed} 个群读取失败，可关闭后重新拉取。</p>` : ''}<div class="grid compact-cards">${feishuGroupsFound.map((g) => `<article class="entity-card"><h3>${esc(g.name)}</h3><p class="muted">${g.role === 'owner' ? '群主' : '管理员'}</p>${data.groups.some((saved) => saved.chatId === g.chatId && saved.projectId === route().id) ? '<span class="pill green">已关联</span>' : data.groups.some((saved) => saved.chatId === g.chatId && saved.projectId) ? '<span class="pill">已关联其他项目</span>' : button('关联到项目', 'import-feishu-group', g.chatId, true)}</article>`).join('')}</div>${!feishuGroupsFound.length ? '<p>本页暂无你管理的群聊。</p>' : ''}<div class="actions form-actions">${button('关闭', 'close')}${page.hasMore ? button('继续查找更多群聊', 'more-feishu-groups', '', true) : '<span class="muted">已检查全部群聊</span>'}</div>`,
    );
  } catch (error) {
    if (generation === groupLoadGeneration && $('#modal').open)
      modal(
        '从飞书选择群聊',
        `<p class="error">${esc(error.message)}</p>${button('重新拉取', 'browse-feishu-groups')}${button('关闭', 'close')}`,
      );
  }
}
function groupDetail(group, section) {
  let content = '';
  if (section === 'info')
    content = panel(
      '群信息',
      '查看群聊标识与项目关联。',
      `<dl class="group-info"><dt>群聊名称</dt><dd>${esc(group.name)}</dd><dt>群聊 ID</dt><dd>${esc(group.chatId)}</dd><dt>来源</dt><dd>${group.source === 'feishu' ? '飞书群聊' : '本地登记'}</dd><dt>关联项目</dt><dd>${group.projectId ? `<a href="#projects/${esc(group.projectId)}">${esc(projectName(group.projectId))} →</a>` : '未关联项目'}</dd><dt>数字员工</dt><dd>${group.employeeIds.length} 位</dd></dl><div class="actions"></div>`,
    );
  if (section === 'employees') {
    const employees = group.employeeIds.map((id) => data.employees.find((e) => e.id === id)).filter(Boolean);
    content = `<div class="section-toolbar"><p class="muted">已关联 ${employees.length} 位数字员工</p></div><div class="grid compact-cards">${employees.map((e) => `<article class="entity-card"><div class="card-top">${entityMark('employees', e.id)}${badge(e.enabled ? '已启用' : '已停用', e.enabled ? 'green' : '')}</div><h3><a href="#employees/${esc(e.id)}">${esc(e.name)}</a></h3><p class="card-description">${esc(e.description || '暂无描述')}</p><div class="card-footer"><span>群数字员工</span><a href="#employees/${esc(e.id)}">查看详情 →</a></div></article>`).join('')}</div>${employees.length ? '' : empty('尚未添加数字员工', '请在飞书中将机器人拉入群聊，收到事件后自动展示。')}`;
  }
  if (section === 'members')
    content = `<div class="section-toolbar"><p class="muted">飞书群成员（人员），数字员工请查看对应标签。</p>${button('刷新成员', 'refresh-group-members', group.id)}</div><div id="group-members-content" aria-live="polite"><p class="muted">正在读取群成员…</p></div>`;
  return (
    `<a class="back" href="#groups">← 群聊</a>` +
    head(group.name, '管理群聊信息、数字员工与群成员') +
    tabs('groups', group.id, { info: '群信息', employees: '群数字员工', members: '群成员' }, section) +
    content
  );
}
let memberLoadGeneration = 0;
let groupMemberRows = [];
let groupMemberPage = '';
async function loadGroupMembers(id, more = false) {
  const generation = ++memberLoadGeneration;
  const container = $('#group-members-content');
  if (!container) return;
  const valid = () =>
    generation === memberLoadGeneration && container === $('#group-members-content') && route().id === id;
  if (!more) {
    groupMemberRows = [];
    groupMemberPage = '';
  }
  container.querySelectorAll('button').forEach((b) => {
    b.disabled = true;
  });
  try {
    const result = await request(
      `/groups/${encodeURIComponent(id)}/members?pageToken=${encodeURIComponent(groupMemberPage)}`,
    );
    if (!valid()) return;
    for (const member of result.members)
      if (!groupMemberRows.some((m) => m.id === member.id)) groupMemberRows.push(member);
    groupMemberPage = result.pageToken;
    container.innerHTML = `<p class="muted">已加载 ${groupMemberRows.length} 位成员${Number.isInteger(result.total) ? ` · 共 ${result.total} 位` : ''}</p>${result.limited ? '<p class="muted">受飞书群安全设置限制，仅展示允许查看的成员。</p>' : ''}<div class="grid compact-cards">${groupMemberRows.map((m) => `<article class="entity-card"><span class="member-avatar">${esc(m.name.slice(0, 1))}</span><h3>${esc(m.name)}</h3><p class="card-description">${esc(m.id)}</p></article>`).join('')}</div>${!groupMemberRows.length ? empty('暂无可显示的群成员', '飞书当前未返回可查看的人员。') : ''}${result.hasMore && result.pageToken ? `<div class="actions form-actions">${button('加载更多成员', 'more-group-members', id)}</div>` : ''}`;
  } catch (error) {
    if (valid())
      container.innerHTML = `<p class="error">${esc(error.message)}</p>${button('重新加载成员', 'refresh-group-members', id)}`;
  }
}
let groupProjectFilter = '',
  groupEmployeeFilter = '';
function groupsOverview() {
  return (
    head('群聊', '查看数字员工在哪些飞书群工作。', '') +
    `<p class="demo-note">工作现场按机器人进退群事件同步。请在飞书中添加或移除机器人；项目关联在项目详情中维护。</p><div class="toolbar group-toolbar"><span class="muted">共 ${data.groups.length} 个群聊</span><div class="group-filters">${select('项目', 'groupProjectFilter', groupProjectFilter, [['', '全部项目'], ['unassigned', '未关联项目'], ...data.projects.map((p) => [p.id, p.name])])}${select('数字员工', 'groupEmployeeFilter', groupEmployeeFilter, [['', '全部员工'], ...data.employees.map((e) => [e.id, e.name])])}<input id="search" class="search" aria-label="搜索群聊" placeholder="搜索群聊、项目或员工…" value="${esc(search)}" /></div></div><div class="grid compact-cards">${data.groups
      .filter(
        (g) =>
          (!groupProjectFilter ||
            (groupProjectFilter === 'unassigned' ? !g.projectId : g.projectId === groupProjectFilter)) &&
          (!groupEmployeeFilter || g.employeeIds.includes(groupEmployeeFilter)),
      )
      .map(
        (group) =>
          `<article class="entity-card" data-search="${esc([group.name, group.chatId, projectName(group.projectId), ...group.employeeIds.map(employeeName)].join(' '))}"><div class="card-top">${entityMark('groups', group.id)}${badge(group.source === 'feishu' ? '飞书群聊' : '本地登记')}</div><h3><a href="#groups/${esc(group.id)}">${esc(group.name)}</a></h3><p class="card-description resource-id" title="${esc(group.chatId)}">${esc(group.chatId)}</p><p class="muted">${group.projectId ? `<a href="#projects/${esc(group.projectId)}/groups">${esc(projectName(group.projectId))}</a>` : '未关联项目'}</p><p>服务员工 · ${esc(group.employeeIds.map(employeeName).join('、') || '尚未配置')}</p><div class="actions"></div><div class="card-footer"><span>${group.employeeIds.length} 位数字员工</span><a href="#groups/${esc(group.id)}">查看详情 →</a></div></article>`,
      )
      .join(
        '',
      )}</div><div id="filter-empty" hidden>${empty('没有匹配群聊', '登记群聊或调整搜索关键词。')}</div>`
  );
}
function overview(module) {
  const employees = module === 'employees';
  const items = employees ? data.employees : data.projects;
  return (
    head(
      names[module],
      employees ? '配置数字员工，让能力在项目中复用。' : '连接群聊与成员，沉淀共同的项目记忆。',
      (employees ? button('初始化数字员工', 'choose-employee-template') : '') +
        button(
          employees ? '＋ 创建员工' : '＋ 创建项目',
          employees ? 'new-employee' : 'new-project',
          '',
          true,
        ),
    ) +
    `<div class="toolbar"><span class="muted">共 ${items.length} ${employees ? '位员工' : '个项目'}</span><input id="search" class="search" aria-label="搜索${names[module]}" placeholder="搜索${names[module]}…" value="${esc(search)}" /></div><div class="grid compact-cards">` +
    items
      .map(
        (item) =>
          `<article class="entity-card" data-search="${esc(item.name + ' ' + item.description)}"><div class="card-top">${entityMark(module, item.id)}${employees ? badge(item.activeVersion ? '已发布' : '草稿', item.activeVersion ? 'green' : '') : badge(`${item.groups.length} 个群聊`)}</div><h3><a href="#${module}/${item.id}">${esc(item.name)}</a></h3><p class="card-description">${esc(item.description || '暂无描述')}</p><div class="card-footer"><span>${employees ? `${item.skills.filter((s) => s.enabled).length} 项技能 · ${item.memoryStores.length} 个记忆库` : `${item.memoryStores.length} 个记忆库`}</span><a href="#${module}/${item.id}" aria-label="查看${esc(item.name)}">查看详情 →</a></div></article>`,
      )
      .join('') +
    `</div><div id="filter-empty" hidden>${empty('没有匹配结果', '换个关键词试试。')}</div>`
  );
}
async function chooseEmployeeTemplate() {
  try {
    const result = await request('/employee-templates');
    modal(
      '初始化数字员工',
      `<p class="muted">选择场景创建完整配置。有方舟 Key 时先上传或复用 MA 技能，再绑定到员工；已有员工保留修改。未配置 Key 时仅创建配置，技能待初始化。</p><div class="grid compact-cards">${result.templates.map((template) => `<article class="entity-card"><h3>${esc(template.name)}</h3><p>${esc(template.description)}</p><p class="muted">${template.skills.length} 个配套 Skill · 方法规范与记忆模板</p><p class="muted">${template.dependencies.map((d) => esc(d.name)).join(' · ')}</p>${button('初始化 / 补齐技能', 'initialize-template', template.key, true)}</article>`).join('')}</div><p id="template-init-progress" role="status"></p>`,
    );
  } catch (error) {
    toast(error.message);
  }
}
function templateDependencies(e) {
  if (!Array.isArray(e.dependencies) || !e.dependencies.length) return '';
  return panel(
    '场景依赖',
    '下面是配置要求，尚未进行外部连通性验证。具体契约在员工记忆 config/dependencies.json 中。',
    `<div class="grid compact-cards">${e.dependencies.map((d) => `<article class="entity-card"><h3>${esc(d.name)}</h3>${badge(d.status)}<p>${esc(d.description)}</p></article>`).join('')}</div>`,
  );
}
function employeeDetail(e, section) {
  let content;
  if (section === 'basic')
    content = panel(
      '基础信息',
      '用于识别员工及其服务范围。',
      `<div class="form-grid">${field('名称', 'name', e.name, '输入员工名称', true)}${select(
        '状态',
        'enabled',
        String(e.enabled),
        [
          ['true', '启用'],
          ['false', '停用'],
        ],
      )}<div class="full">${area('描述', 'description', e.description, 3)}</div></div>`,
    );
  if (section === 'basic') content += templateDependencies(e);
  if (section === 'identity')
    content = panel(
      '身份',
      '定义员工的角色、职责与能力边界。',
      area('身份提示词', 'identity', e.identity, 12),
    );
  if (section === 'knowledge')
    content =
      panel('知识', '员工跨项目可复用的参考知识。', area('参考知识', 'knowledge', e.knowledge, 8)) +
      panel('规则', '约定员工必须遵守的行为与输出要求。', area('行为规则', 'rules', e.rules, 6));
  if (section === 'environment') content = environmentPanel(e);
  if (section === 'channels')
    content = ['feishu', 'doubao']
      .map((key) => {
        const channel = e.channels[key];
        const feishu = key === 'feishu';
        if (feishu)
          return panel(
            '飞书',
            '新建或使用已有飞书应用，绑定后自动启动消息服务。',
            `<div class="actions">${button('接入飞书', 'connect-feishu', '', true)}${button('查看接入状态', 'view-feishu')}</div>`,
          );
        return panel(
          feishu ? '飞书' : '豆包',
          '仅保存接入配置，不建立真实连接。',
          `<div class="form-grid">${select('接入状态', key + 'Enabled', String(channel.enabled), [
            ['false', '未启用'],
            ['true', '启用'],
          ])}${field(feishu ? '飞书 App ID' : '豆包 Agent ID', feishu ? 'appId' : 'agentId', feishu ? channel.appId : channel.agentId, '填写渠道标识')}</div>`,
        );
      })
      .join('');
  if (section === 'skills')
    content = `<div class="section-toolbar"><p class="muted">使用当前方舟 APIKey 从 MA 选择真实 Skill。修改后通过页面顶部「MA 配置」同步到远端 Agent。</p>${button('＋ 从 MA 添加技能', 'add-skill')}</div><div class="grid compact-cards">${e.skills.map((skill) => `<article class="entity-card"><div class="card-top">${entityMark('skill', skill.id)}${badge(skill.enabled ? '已启用' : '已停用', skill.enabled ? 'green' : '')}</div><h3>${esc(skill.name)}</h3><p class="card-description">${esc(skill.description)}</p><p class="muted">MA · v${esc(skill.version || '')}<br>${esc(skill.id)}</p><div class="actions">${button(skill.enabled ? '停用' : '启用', 'toggle-skill', skill.id)}${button('移除', 'remove-skill', skill.id)}</div></article>`).join('')}</div>${!e.skills.length ? empty('暂无 MA 技能', '从 MA 技能列表选择并绑定，不使用本地模拟技能。') : ''}`;
  if (section === 'memories') content = memoryList(e, false);
  if (section === 'credentials')
    content = `<div class="section-toolbar"><p class="muted">仅登记凭证名称和引用标识，不接收或保存密钥。</p>${button('＋ 登记凭证', 'add-credential')}</div><div class="grid compact-cards">${e.credentials.map((credential) => `<article class="entity-card"><div class="card-top">${entityMark('credential', credential.id)}${badge('待后端接入')}</div><h3>${esc(credential.name)}</h3><p class="card-description">${esc(credential.reference)}</p><div class="card-footer"><span>凭证引用</span>${button('移除', 'remove-credential', credential.id)}</div></article>`).join('')}</div>${!e.credentials.length ? empty('尚未登记凭证', '登记凭证引用后，由后端完成安全存储与授权。') : ''}`;
  if (section === 'versions')
    content = `<div class="section-toolbar"><p class="muted">保存当前配置快照，支持本地版本发布与切换。</p>${button('发布版本', 'publish', '', true)}</div><div class="version-stack">${[
      ...e.versions,
    ]
      .reverse()
      .map(
        (version) =>
          `<article class="panel version-card"><div><h3>v${version.number} ${version.id === e.activeVersion ? badge('当前版本', 'green') : ''}</h3><p class="muted">${esc(version.note)} · ${date(version.createdAt)}</p></div><div class="actions">${button('查看配置', 'view-version', version.id)}${version.id !== e.activeVersion ? button('切换到此版本', 'activate-version', version.id) : ''}</div></article>`,
      )
      .join('')}</div>${!e.versions.length ? empty('暂无版本', '完成员工配置后，发布第一个本地版本。') : ''}`;
  const editable = ['basic', 'identity', 'knowledge', 'environment', 'channels'].includes(section);
  return (
    `<a class="back" href="#employees">← 数字员工</a>` +
    head(
      e.name,
      e.description || '完善员工配置',
      `<div class="actions">${badge(e.enabled ? '启用' : '停用', e.enabled ? 'green' : '')}${button('MA 配置', 'view-ma-sync', e.id)}</div>`,
    ) +
    `<div class="employee-summary"><span>版本<b>${e.activeVersion ? 'v' + e.versions.find((v) => v.id === e.activeVersion)?.number : '未发布'}</b></span><span>技能<b>${e.skills.filter((s) => s.enabled).length}</b></span><span>记忆库<b>${e.memoryStores.length}</b></span></div>` +
    tabs('employees', e.id, employeeTabs, section) +
    (editable
      ? `<form id="employee-form" data-section="${section}" class="config-form">${content}${saveBar()}</form>`
      : content)
  );
}
let selectedMemoryStore = '';
let selectedMemoryEntry = '';
let editingMemory = false;
let pendingMemoryAction = null;
const environmentChoices = new Map();
async function loadEnvironmentChoices(employeeId) {
  environmentChoices.set(employeeId, { loading: true });
  try {
    const path = `/employees/${encodeURIComponent(employeeId)}/environment`;
    let result = await request(path);
    if (!result.recommendedId) {
      await request('/ma-environments/recommended', 'POST', {});
      result = await request(path);
    }
    environmentChoices.set(employeeId, result);
  } catch (error) {
    environmentChoices.set(employeeId, { error: error.message });
  }
  if (route().id === employeeId && route().section === 'environment' && !dirty) render();
}
function environmentNote(item) {
  if (!item) return '请选择一个可用的 MA 环境。';
  const cli =
    item.larkCli === 'startup'
      ? `启动时自动安装 lark-cli ${item.larkCliVersion}，并校验安装包 SHA256。`
      : '未确认此环境是否预装 lark-cli，请确保所选环境满足飞书技能依赖。';
  return `${item.id} · ${item.type} · ${cli}`;
}
function environmentSelect(result, selectedId, query = '') {
  const available = result.environments.filter((e) => e.compatible);
  const matches = available
    .filter((e) => (e.name + ' ' + e.id).toLowerCase().includes(query.toLowerCase()))
    .slice(0, 50);
  const current = available.find((e) => e.id === selectedId);
  if (current && !matches.some((e) => e.id === selectedId)) matches.unshift(current);
  const options = matches.map((e) => [e.id, `${e.name} · ${e.id}${e.recommended ? '（推荐）' : ''}`]);
  if (selectedId && !current) options.unshift([selectedId, '当前环境不可用，请重新选择']);
  return select('运行环境', 'maEnvironmentId', selectedId, options);
}
function environmentPanel(employee) {
  const result = environmentChoices.get(employee.id);
  if (!result) {
    void loadEnvironmentChoices(employee.id);
    return panel('MA 运行环境', '正在读取 MA 环境…', '');
  }
  if (result.loading) return panel('MA 运行环境', '正在读取 MA 环境…', '');
  if (result.error)
    return panel('MA 运行环境', esc(result.error), button('重新读取', 'refresh-environments', employee.id));
  const selectedId = employee.environment.maEnvironmentId || result.selectedId;
  const choices = result.environments.filter((e) => e.compatible);
  return panel(
    'MA 运行环境',
    '选择 MA 侧的真实环境。保存后发送 /new，新 Session 使用所选环境。',
    `<div class="section-toolbar"><span class="muted">已隐藏固定绑定其他飞书应用的环境</span>${button('刷新环境', 'refresh-environments', employee.id)}</div>` +
      '<label>搜索 MA 环境<input id="environment-search" placeholder="输入环境名称或 ID，查看更多环境" type="search" /></label>' +
      `<div id="environment-select">${environmentSelect(result, selectedId)}</div>` +
      `<p id="environment-note" class="demo-note">${esc(environmentNote(choices.find((e) => e.id === selectedId)))}</p>` +
      `<div class="form-grid">${field('模型', 'model', employee.environment.model)}<label>运行超时（秒）<input type="number" name="timeout" min="30" max="3600" value="${employee.environment.timeout}" required /></label></div><p class="demo-note">模型通过「MA 配置」同步；超时在 Channel 重启后生效。</p>`,
  );
}
function memoryTreeMarkup(node) {
  return (
    [...node.folders]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, child]) =>
          `<details open class="memory-folder"><summary>▱ ${esc(name)}</summary><div>${memoryTreeMarkup(child)}</div></details>`,
      )
      .join('') +
    [...node.files]
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map((entry) =>
        entry.id === selectedMemoryEntry
          ? `<div class="memory-file selected memory-file-inline"><span aria-hidden="true">▤</span><input id="memory-path-input" aria-label="条目路径（双击或按 F2 修改）" value="${esc(entry.filename)}" title="${esc(entry.path)} · 双击或按 F2 修改路径" readonly /></div>`
          : `<button type="button" class="memory-file" data-action="select-memory" data-id="${esc(entry.id)}" title="${esc(entry.path)}"><span aria-hidden="true">▤</span> ${esc(entry.filename)}</button>`,
      )
      .join('')
  );
}
let loadedMemoryKey = '',
  loadingMemoryKey = '',
  memoryLoadError = '';
function memoryApiBase() {
  const r = route();
  return `/${r.module}/${encodeURIComponent(r.id)}/memory`;
}
async function refreshRemoteMemory() {
  const { owner } = context();
  if (!owner || owner.memoryMode !== 'ma') return;
  const base = memoryApiBase(),
    store = selectedMemoryStore,
    key = base + '/' + store;
  loadingMemoryKey = key;
  memoryLoadError = '';
  try {
    const result = await request(base + (store ? `?storeId=${encodeURIComponent(store)}` : ''));
    if (memoryApiBase() !== base || selectedMemoryStore !== store) return;
    owner.memoryStores = result.stores;
    owner.memories = result.entries;
    loadedMemoryKey = key;
  } catch (error) {
    if (memoryApiBase() === base) {
      memoryLoadError = error.message;
      loadedMemoryKey = key;
    }
  } finally {
    if (loadingMemoryKey === key) loadingMemoryKey = '';
    if (memoryApiBase() === base) render();
  }
}
async function readRemoteMemory(entry) {
  if (entry.loading) return;
  entry.loading = true;
  const base = memoryApiBase();
  try {
    const result = await request(
      `${base}/entries/${encodeURIComponent(entry.id)}?storeId=${encodeURIComponent(entry.storeId)}`,
    );
    Object.assign(entry, result);
  } catch (error) {
    entry.loadError = error.message;
  } finally {
    entry.loading = false;
    if (memoryApiBase() === base) render();
  }
}
function memoryDocument(entry) {
  if (!entry) return empty('暂无条目', '添加一个路径和文本内容，开始维护记忆。');
  if (entry.content === undefined) {
    if (!entry.loadError) void readRemoteMemory(entry);
    return `<p class="muted">${esc(entry.loadError || '正在从 MA 读取正文…')}</p>`;
  }
  return `<form id="memory-entry-form" data-kind="memory" data-id="${esc(entry.id)}"><div class="memory-document-head"><div class="memory-title-actions"><strong id="memory-document-path" class="memory-path">/${esc(entry.path)}</strong>${button('基础信息', 'memory-info', entry.id)}</div><div class="actions">${button('删除', 'delete-memory', entry.id)}${button('取消', 'cancel-memory')}<button class="primary" type="submit">保存</button></div></div>${['storeId', 'path', 'title', 'source', 'sha'].map((name) => `<input type="hidden" name="${name}" value="${esc(entry[name])}" />`).join('')}<div class="memory-inline-editor"><div id="memory-line-numbers" aria-hidden="true">${entry.content
    .split('\n')
    .map((_, i) => i + 1)
    .join(
      '\n',
    )}</div><textarea aria-label="文本内容" name="content" class="memory-direct-text" spellcheck="false" wrap="off" maxlength="30000" required>${esc(entry.content)}</textarea></div><div class="memory-document-foot"><span id="save-state">点击内容直接编辑 · 双击左侧文件名修改路径</span><span>更新于 ${date(entry.updatedAt)}</span></div></form>`;
}
function memoryList(owner, project) {
  migrateMemories(data);
  if (owner.memoryMode !== 'ma')
    return `<div class="panel"><h3>将记忆存储到 MA</h3><p>已有 ${owner.memoryStores.length} 个记忆库、${owner.memories.length} 条记忆待迁移。迁移完成后，增删改查直接使用 MA Memory Store。</p>${button(owner.memories.length ? '迁移并启用 MA 记忆' : '启用 MA 记忆库', 'migrate-ma-memory', '', true)}</div>`;
  const key = memoryApiBase() + '/' + selectedMemoryStore;
  if (loadedMemoryKey !== key) {
    if (loadingMemoryKey !== key) void refreshRemoteMemory();
    return '<p class="muted">正在从 MA 读取记忆库…</p>';
  }
  if (memoryLoadError)
    return `<p class="error">${esc(memoryLoadError)}</p>${button('重新读取', 'refresh-memory')}`;
  const store = owner.memoryStores.find((item) => item.id === selectedMemoryStore);
  if (!store)
    return `<div class="section-toolbar"><p class="muted">${project ? '项目' : '员工'}记忆按记忆库组织，每个条目包含路径和文本内容。</p><div class="actions">${button('刷新', 'refresh-memory')}${button('＋ 创建记忆库', 'add-store', '', true)}</div></div><div class="grid compact-cards">${owner.memoryStores.map((item) => `<article class="entity-card">${entityMark('memory', item.id)}<h3>${esc(item.name)}</h3><p class="card-description">${esc(item.description || '通过路径组织长期记忆')}</p><p class="muted">${item.memoryCount ?? 0} 个条目 · MA</p><div class="actions">${button('查看条目', 'open-store', item.id, true)}${button('编辑', 'edit-store', item.id)}${button('删除库', 'delete-ma-store', item.id)}</div></article>`).join('')}</div>`;
  const entries = owner.memories.filter((entry) => entry.storeId === store.id);
  const entry = entries.find((item) => item.id === selectedMemoryEntry) || entries[0];
  selectedMemoryEntry = entry?.id || '';
  return `<div class="section-toolbar"><div>${button('← 记忆库', 'back-stores')} <strong>${esc(store.name)}</strong></div><div class="actions">${button('刷新', 'refresh-memory')}${button('＋ 添加条目', 'add-memory', '', true)}</div></div><div class="memory-workspace"><nav class="memory-tree" aria-label="记忆路径树"><div class="memory-tree-head"><span>路径树</span><span>${entries.length}</span></div>${memoryTreeMarkup(memoryTree(entries))}</nav><section class="memory-document">${memoryDocument(entry)}</section></div>`;
}
function projectDetail(p, section) {
  if (!Object.hasOwn(projectTabs, section)) section = 'memories';
  let content = '';
  if (section === 'memories')
    content =
      `<div class="actions">${button('整理近期 Session', 'organize-memory', p.id)}</div>` +
      memoryList(p, true);
  if (section === 'groups')
    content = `<div class="section-toolbar"><p class="muted">群内员工加载自身记忆和本项目记忆；关联变更后请使用 /new。</p><div class="actions">${button('＋ 从飞书关联群聊', 'browse-feishu-groups', '', true)}</div></div><div class="grid compact-cards">${p.groups.map((group) => `<article class="entity-card">${entityMark('groups', group.id)}<h3><a href="#groups/${esc(group.id)}">${esc(group.name)}</a></h3><p class="card-description resource-id" title="${esc(group.chatId)}">${esc(group.chatId)}</p><p class="muted">数字员工 · ${esc(group.employeeIds.map(employeeName).join('、') || '尚未配置')}</p><div class="actions">${button('添加数字员工', 'invite-project-group', group.id, true)}${button('解除关联', 'remove-group', group.id)}</div></article>`).join('')}</div>${!p.groups.length ? empty('尚未关联群聊', '将群聊关联到项目，组织项目协作。') : ''}`;
  return (
    '<a class="back" href="#projects">← 项目</a>' +
    head(p.name, p.description, button('编辑项目', 'edit-project')) +
    `<div class="employee-summary"><span>项目记忆库<b>${p.memoryStores.length}</b></span><span>群聊<b>${p.groups.length}</b></span></div>` +
    tabs('projects', p.id, projectTabs, section) +
    content
  );
}
function runningTasks() {
  const history = route().id === 'history';
  const active = activeTasks(data.tasks);
  const ended = data.tasks
    .filter((task) => ['completed', 'cancelled', 'failed'].includes(task.status))
    .sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''))
    .slice(0, 20);
  const rows = history ? ended : active;
  const statuses = history
    ? [
        ['completed', '已完成'],
        ['failed', '失败'],
        ['cancelled', '已取消'],
      ]
    : [
        ['running', '执行中'],
        ['queued', '等待中'],
      ];
  const labels = Object.fromEntries(statuses);
  return (
    head(
      '任务',
      '查看记忆整理任务与本地验收任务的进度和结果。',
      button('＋ 发起本地任务', 'new-task', '', true),
    ) +
    `<nav class="detail-tabs task-tabs" aria-label="任务分类"><a href="#tasks" class="${history ? '' : 'active'}" ${history ? '' : 'aria-current="page"'}>运行中 <span class="task-tab-count">${active.length}</span></a><a href="#tasks/history" class="${history ? 'active' : ''}" ${history ? 'aria-current="page"' : ''}>最近结束 <span class="task-tab-count">${ended.length}</span></a></nav><p class="muted">${history ? '显示最近结束的 20 项任务' : `${active.filter((r) => r.status === 'running').length} 项执行中 · ${active.filter((r) => r.status === 'queued').length} 项等待中`} · 每 2 秒更新</p><div class="observation-filters"><input id="search" class="search" aria-label="搜索任务" placeholder="搜索任务、员工或项目…" value="${esc(search)}" />${select(
      '类型',
      'typeFilter',
      typeFilter,
      [
        ['all', '全部类型'],
        ['run', '员工运行'],
        ['memory', '记忆任务'],
      ],
    )}${select('状态', 'statusFilter', statusFilter, [
      ['all', '全部状态'],
      ...statuses,
    ])}</div><div class="grid compact-cards">${rows.map((row) => `<article class="entity-card" data-search="${esc(row.name + employeeName(row.employeeId) + projectName(row.projectId))}" data-status="${esc(row.status)}" data-type="${esc(row.type)}"><div class="card-top"><span class="muted">本地上下文快照</span>${badge(labels[row.status], ['running', 'completed'].includes(row.status) ? 'green' : row.status === 'failed' ? 'red' : '')}</div><h3>${esc(row.name)}</h3><p class="card-description">${esc(employeeName(row.employeeId))}<br/>${esc(projectName(row.projectId))}</p><p>${esc(row.progress)}</p><div class="card-footer">${history ? `<span>${row.finishedAt ? esc(date(row.finishedAt)) : '已结束'}</span>` : button('取消任务', 'cancel-task', row.id)}${button(history ? '查看结果' : '查看进度', 'view-task', row.id)}</div></article>`).join('')}</div><div id="filter-empty" hidden>${empty(rows.length ? '没有匹配任务' : history ? '暂无最近结束的任务' : '暂无运行中的任务', rows.length ? '调整关键词或筛选条件。' : history ? '任务结束后会显示在这里。' : '点击发起本地任务开始验收。')}</div>`
  );
}
function applyFilters() {
  const cards = document.querySelectorAll('[data-search]');
  let visible = 0;
  cards.forEach((card) => {
    const matches =
      card.dataset.search.toLowerCase().includes(search.toLowerCase()) &&
      (!card.dataset.status || statusFilter === 'all' || card.dataset.status === statusFilter) &&
      (!card.dataset.type || typeFilter === 'all' || card.dataset.type === typeFilter);
    card.hidden = !matches;
    if (matches) visible++;
  });
  if ($('#filter-empty')) $('#filter-empty').hidden = visible > 0;
}
function context() {
  const r = route();
  return {
    ...r,
    owner: (r.module === 'employees' ? data.employees : data.projects).find((item) => item.id === r.id),
  };
}
function editDialog(kind, item = {}) {
  const { owner } = context();
  let title, fields;
  if (kind === 'task') {
    title = '发起本地任务';
    fields =
      '<p class="muted">生成上下文快照，不调用 MA，不发送群消息。</p>' +
      field('任务名称', 'name', '上下文验收', '', true) +
      select(
        '数字员工',
        'employeeId',
        '',
        data.employees.filter((employee) => employee.enabled).map((employee) => [employee.id, employee.name]),
      ) +
      select('关联项目', 'projectId', '', [
        ['', '无项目'],
        ...data.projects.map((project) => [project.id, project.name]),
      ]) +
      `<input type="hidden" name="requestId" value="${uid()}" />`;
  }
  if (kind === 'employee' || kind === 'project') {
    title = (item.id ? '编辑' : '创建') + (kind === 'employee' ? '数字员工' : '项目');
    fields =
      field('名称', 'name', item.name, '填写名称', true) + area('描述', 'description', item.description, 3);
  }
  if (kind === 'memory') {
    title = item.id ? '编辑记忆条目' : '添加记忆条目';
    fields =
      select(
        '记忆库',
        'storeId',
        item.storeId || selectedMemoryStore,
        owner.memoryStores.map((store) => [store.id, store.name]),
      ) +
      field('条目路径', 'path', item.path, '例如 notes/brief.md', true) +
      '<p class="muted">填写库内相对路径；同一记忆库内路径唯一。</p>' +
      field('标题（可选）', 'title', item.title, '一句话说明条目') +
      area('文本内容', 'content', item.content, 12) +
      field('来源说明', 'source', item.source, '例如：已确认的项目会议');
  }
  if (kind === 'store') {
    title = item.id ? '编辑记忆库' : '创建记忆库';
    fields =
      field('记忆库名称', 'name', item.name, '例如 项目共识', true) +
      area('描述', 'description', item.description, 3);
  }
  if (kind === 'memory-info') {
    title = '条目基础信息';
    fields =
      select(
        '所属记忆库',
        'storeId',
        item.storeId,
        owner.memoryStores
          .filter((store) => store.id === item.storeId)
          .map((store) => [store.id, store.name]),
      ) +
      field('标题（可选）', 'title', item.title) +
      field('来源说明', 'source', item.source);
  }
  if (kind === 'project-invite') {
    title = '添加数字员工 · ' + item.name;
    fields =
      '<p class="muted">将员工机器人实际加入此飞书群，入群后加载该群所属项目的记忆。</p>' +
      select(
        '数字员工',
        'employeeId',
        '',
        item.availableEmployees.filter((e) => !item.employeeIds.includes(e.id)).map((e) => [e.id, e.name]),
      );
  }
  if (kind === 'credential') {
    title = '登记凭证引用';
    fields =
      '<p class="muted">请勿输入 API Key、Secret 或 Token 明文。</p>' +
      field('凭证名称', 'name', '', '例如：资料库凭证', true) +
      field('凭证引用标识', 'reference', '', '例如：credential://knowledge-reader', true);
  }
  if (kind === 'publish') {
    title = '发布本地版本';
    fields =
      '<p class="muted">将当前已保存配置生成本地版本快照，不会发布到 MA。</p>' +
      field('版本说明', 'note', '', '概述本次调整', true);
  }
  modal(
    title,
    `<form id="dialog-form" data-kind="${kind}" data-id="${esc(item.id || '')}" data-owner="${esc(owner?.id || '')}">${fields}<div class="actions form-actions">${button('取消', 'close')}<button class="primary" type="submit">${kind === 'project-invite' ? '确认添加到飞书群' : kind === 'publish' ? '确认发布' : kind === 'memory-info' ? '应用' : '保存'}</button></div><p class="demo-note">${kind === 'project-invite' ? '入群成功后保存服务关联，机器人将能接收该群中的消息。' : kind === 'memory-info' ? '应用后，点击内容区顶部的保存，与正文和路径一起保存。' : ['memory', 'store'].includes(kind) ? '直接保存到 MA 记忆库' : '保存到本机工作台'}</p></form>`,
  );
}
function confirmAction(title, text, action, id) {
  modal(
    title,
    `<p>${esc(text)}</p><div class="actions form-actions">${button('取消', 'close')}${button('确认', action, id, true)}</div>`,
  );
}
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  let action = target.dataset.action,
    id = target.dataset.id;
  if (action === 'discard-memory' && pendingMemoryAction) {
    ({ action, id } = pendingMemoryAction);
    pendingMemoryAction = null;
    dirty = false;
    closeModal();
  }
  const { owner } = context();
  if (action === 'choose-employee-template') return chooseEmployeeTemplate();
  if (action === 'initialize-template' || action === 'initialize-ada') {
    const buttons = [...document.querySelectorAll('[data-action="initialize-template"]')];
    buttons.forEach((b) => (b.disabled = true));
    const progress = $('#template-init-progress');
    if (progress) progress.textContent = '正在初始化配置并核验 MA 技能，请稍候。可在任务页查看进度。';
    try {
      const result = await request(
        `/employee-templates/${encodeURIComponent(action === 'initialize-ada' ? 'ada' : id)}/initialize`,
        'POST',
        {},
      );
      acceptServer(result);
      closeModal();
      history.pushState(null, '', `#employees/${result.employeeId}/basic`);
      render();
      toast(result.message || (result.created ? '员工已初始化' : '已打开现有员工'));
    } catch (error) {
      if (progress?.isConnected) progress.textContent = error.message;
      toast(error.message);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
    return;
  }
  if (action === 'add-skill') return browseMaSkills(owner.id);
  if (action === 'view-ma-sync' || action === 'sync-ma-agent') {
    target.disabled = true;
    try {
      const state = await request(
        `/employees/${encodeURIComponent(id)}/${action === 'sync-ma-agent' ? 'sync-ma' : 'feishu'}`,
        action === 'sync-ma-agent' ? 'POST' : 'GET',
        action === 'sync-ma-agent' ? {} : undefined,
      );
      modal(
        'MA 配置同步',
        `<p>${state.agentId ? (state.configurationSynced ? '已同步到 MA' : '配置有变更，待同步到 MA') : '尚未创建 MA Agent，请先完成飞书接入'}</p>
        ${state.agentId ? `<p class="muted">Agent：${esc(state.agentId)}${state.agentVersion ? ` · v${esc(state.agentVersion)}` : ''}</p><p class="muted">同步已保存的名称、描述、身份、知识与规则、模型及技能。同步后在飞书发送 /new 创建新 Session，新配置才会生效；旧 Session 的文件仍留在原会话。</p><div class="actions">${button('关闭', 'close')}${button('同步已保存配置', 'sync-ma-agent', id, true)}</div>` : button('关闭', 'close')}`,
      );
    } catch (error) {
      toast(error.message);
    } finally {
      target.disabled = false;
    }
    return;
  }
  if (action === 'bind-ma-skill') {
    target.disabled = true;
    try {
      acceptServer(
        await request(`/employees/${encodeURIComponent(maSkillEmployee)}/skills`, 'POST', { skillId: id }),
      );
      closeModal();
      render();
      toast('已绑定 MA Skill ID 与版本');
    } catch (error) {
      toast(error.message);
      target.disabled = false;
    }
    return;
  }
  if (action === 'reconnect') return connectWorkspace();
  if (action === 'ma-config') return openMaConfig();
  if (action === 'initialize-ma') return initializeMaResources();
  if (action === 'retry-feishu') return openFeishu(id, true, true);
  if (action === 'upgrade-feishu') return openFeishu(id, true, false, true);
  if (action === 'resume-feishu') return openFeishu(id, true);
  if (action === 'connect-feishu') return chooseFeishu(owner.id);
  if (action === 'create-feishu') return openFeishu(feishuDialogId, true);
  if (action === 'existing-feishu') return existingFeishu(feishuDialogId);
  if (action === 'view-feishu') return openFeishu(owner.id);
  if (action === 'new-task') return editDialog('task');
  if (action === 'browse-feishu-groups') return browseFeishuGroups();
  if (action === 'more-feishu-groups') return browseFeishuGroups(true);
  if (action === 'invite-project-group') {
    target.disabled = true;
    const projectId = owner.id;
    try {
      const result = await request(`/projects/${projectId}/groups/${id}/employees`);
      if (route().module !== 'projects' || route().id !== projectId) return;
      const group = data.groups.find((g) => g.id === id);
      if (!result.employees.some((e) => !group.employeeIds.includes(e.id)))
        return toast('暂无可添加的员工，请先完成其他员工的飞书连接');
      editDialog('project-invite', { ...group, availableEmployees: result.employees });
    } catch (error) {
      toast(error.message);
    } finally {
      target.disabled = false;
    }
    return;
  }
  if (action === 'import-feishu-group') {
    target.disabled = true;
    try {
      acceptServer(await request('/feishu-groups', 'POST', { chatId: id, projectId: route().id }));
      closeModal();
      render();
      toast('群聊已关联项目，请在飞书中添加机器人');
    } catch (error) {
      toast(error.message);
      target.disabled = false;
    }
    return;
  }
  if (action === 'refresh-group-members') return loadGroupMembers(id);
  if (action === 'more-group-members') return loadGroupMembers(id, true);
  if (action === 'cancel-task') {
    try {
      await request(`/tasks/${encodeURIComponent(id)}/cancel`, 'POST', {});
      await refreshTasks();
      toast('任务已取消');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'close') return closeModal();
  if (action === 'new-employee') return editDialog('employee');
  if (action === 'new-project') return editDialog('project');
  if (action === 'edit-project') return editDialog('project', owner);
  if (action === 'view-task') {
    const row = data.tasks.find((r) => r.id === id);
    return modal(
      row.name,
      `<p class="muted">${esc(employeeName(row.employeeId))} · ${esc(projectName(row.projectId))}</p>${badge({ running: '执行中', queued: '等待中', completed: '已完成', cancelled: '已取消', failed: '失败' }[row.status])}<p>${esc(row.detail)}</p><ol class="timeline">${row.steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>${row.result ? `<h3>执行结果</h3><pre class="task-result">${esc(row.result)}</pre>` : '<p class="muted">关闭详情后列表自动更新。</p>'}`,
    );
  }
  if (!owner) return;
  if (action === 'delete-ma-store')
    return confirmAction(
      '删除 MA 记忆库',
      '将永久删除 MA 中的记忆库及全部条目，无法恢复。已挂载该库的会话需要 /new 后继续。',
      'confirm-delete-ma-store',
      id,
    );
  if (action === 'confirm-delete-ma-store') {
    target.disabled = true;
    try {
      acceptServer(await request(`${memoryApiBase()}/stores/${encodeURIComponent(id)}`, 'DELETE', {}));
      selectedMemoryStore = '';
      closeModal();
      loadedMemoryKey = '';
      await refreshRemoteMemory();
      toast('记忆库已从 MA 删除');
    } catch (error) {
      toast(error.message);
    } finally {
      target.disabled = false;
    }
    return;
  }
  if (action === 'refresh-environments') {
    if (dirty) return toast('请先保存当前配置后再刷新环境');
    void loadEnvironmentChoices(id);
    render();
    return;
  }
  if (action === 'organize-memory') {
    if (owner.memoryMode !== 'ma' || !owner.memoryStores.length) return toast('请先创建 MA 项目记忆库');
    modal(
      '整理近期项目 Session',
      `<form id="organize-memory-form" data-project-id="${esc(owner.id)}" data-request-id="${uid()}"><p class="muted">整理最近 7 天、最多 10 个已完成的群聊 Session：人的姓名、职能和协作特点写入数字员工自己的记忆；群里发生的事情、决策与进展写入下方项目记忆库。可在任务页分别查看结果。</p>${select(
        '数字员工',
        'employeeId',
        '',
        data.employees
          .filter((e) => owner.groups.some((g) => g.employeeIds.includes(e.id)))
          .map((e) => [e.id, e.name]),
      )}${select(
        '事情记忆库（项目）',
        'storeId',
        selectedMemoryStore,
        owner.memoryStores.map((s) => [s.id, s.name]),
      )}<div class="actions">${button('取消', 'close')}<button type="submit" class="primary">开始整理</button></div></form>`,
    );
    return;
  }
  if (action === 'migrate-ma-memory' || action === 'refresh-memory') {
    target.disabled = true;
    try {
      if (action === 'migrate-ma-memory')
        acceptServer(await request(memoryApiBase() + '/migrate', 'POST', {}));
      loadedMemoryKey = '';
      memoryLoadError = '';
      await refreshRemoteMemory();
    } catch (error) {
      toast(error.message);
    } finally {
      target.disabled = false;
    }
    return;
  }
  if (action === 'confirm-delete-memory' && owner.memoryMode === 'ma') {
    const entry = owner.memories.find((m) => m.id === id);
    target.disabled = true;
    try {
      await request(`${memoryApiBase()}/entries/${encodeURIComponent(id)}`, 'DELETE', {
        storeId: entry.storeId,
        sha: entry.sha,
      });
      closeModal();
      dirty = false;
      await refreshRemoteMemory();
      toast('已从 MA 删除');
    } catch (error) {
      toast(error.message);
    } finally {
      target.disabled = false;
    }
    return;
  }
  if (action === 'memory-info') {
    const values = Object.fromEntries(new FormData($('#memory-entry-form')));
    return editDialog('memory-info', { id, ...values });
  }
  if (['open-store', 'back-stores', 'select-memory', 'cancel-memory', 'add-memory'].includes(action)) {
    if (dirty) {
      pendingMemoryAction = { action, id };
      return confirmAction(
        '放弃未保存的修改？',
        '当前条目的修改尚未保存。取消可继续编辑。',
        'discard-memory',
      );
    }
    dirty = false;
    editingMemory = false;
  }
  if (action === 'select-memory' || action === 'cancel-memory') {
    if (action === 'select-memory') selectedMemoryEntry = id;
    return render();
  }
  if (action === 'open-store' || action === 'back-stores') {
    selectedMemoryEntry = '';
    selectedMemoryStore = action === 'open-store' ? id : '';
    return render();
  }
  if (action === 'edit-store')
    return editDialog(
      'store',
      owner.memoryStores.find((store) => store.id === id),
    );
  if (action.startsWith('add-')) return editDialog(action.slice(4));
  if (action === 'edit-memory') {
    selectedMemoryEntry = id;
    editingMemory = true;
    return render();
  }
  if (action === 'toggle-skill') {
    const skill = owner.skills.find((s) => s.id === id);
    skill.enabled = !skill.enabled;
    return commit('技能状态已更新');
  }
  if (action === 'publish') return editDialog('publish');
  if (action === 'view-version') {
    const v = owner.versions.find((r) => r.id === id);
    return modal(
      `v${v.number} 配置快照`,
      `<p class="muted">${esc(v.note)}</p><pre>${esc(JSON.stringify(v.snapshot, null, 2))}</pre>`,
    );
  }
  if (action === 'activate-version')
    return confirmAction(
      '切换版本',
      '切换后将用该版本配置替换当前配置，员工记忆会保留。',
      'confirm-version',
      id,
    );
  if (action === 'confirm-version') {
    const v = owner.versions.find((r) => r.id === id);
    Object.assign(owner, copy(v.snapshot), { activeVersion: v.id });
    closeModal();
    return commit('版本已切换');
  }
  if (action.startsWith('remove-') || action === 'delete-memory')
    return confirmAction(
      '确认移除',
      action === 'delete-memory' ? '将从 MA 永久删除此条记忆，确认继续？' : '确认从本机工作台移除此记录？',
      'confirm-' + action,
      id,
    );
  if (action.startsWith('confirm-remove-') || action === 'confirm-delete-memory') {
    if (action === 'confirm-remove-group') {
      try {
        acceptServer(await request(`/projects/${owner.id}/groups/${id}`, 'DELETE', {}));
        closeModal();
        render();
        toast('已解除项目关联，保留在群状态');
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    const collection = {
      'confirm-remove-group': 'groups',
      'confirm-remove-skill': 'skills',
      'confirm-remove-credential': 'credentials',
      'confirm-delete-memory': 'memories',
    }[action];
    if (!collection) return;
    owner[collection] = owner[collection].filter((item) => item.id !== id);
    closeModal();
    return commit('记录已移除');
  }
});
document.addEventListener('submit', async (event) => {
  if (['ma-config-form', 'existing-feishu-form'].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target;
  const values = Object.fromEntries(new FormData(form));
  const { owner } = context();
  if (form.id === 'employee-form') {
    const section = form.dataset.section;
    if (section === 'basic') {
      if (!values.name.trim()) return toast('请填写名称');
      Object.assign(owner, {
        name: values.name.trim(),
        description: values.description.trim(),
        enabled: values.enabled === 'true',
      });
    }
    if (section === 'identity') owner.identity = values.identity;
    if (section === 'knowledge') Object.assign(owner, { knowledge: values.knowledge, rules: values.rules });
    if (section === 'environment') {
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        if (!values.maEnvironmentId) throw new Error('请等待环境加载并选择 MA 环境');
        acceptServer(
          await request(`/employees/${encodeURIComponent(owner.id)}/environment`, 'POST', {
            ...values,
            revision: serverRevision,
          }),
        );
        dirty = false;
        render();
        toast('环境已保存，请发送 /new 后使用');
      } catch (error) {
        toast(error.message);
      } finally {
        submit.disabled = false;
      }
      return;
    }
    if (section === 'channels') {
      if (values.doubaoEnabled === 'true' && !values.agentId.trim()) return toast('启用渠道前请填写对应标识');
      owner.channels = {
        feishu: owner.channels.feishu,
        doubao: { enabled: values.doubaoEnabled === 'true', agentId: values.agentId.trim() },
      };
    }
    owner.updatedAt = new Date().toISOString();
    return commit('配置已保存');
  }
  if (form.id === 'organize-memory-form') {
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await request(`/projects/${encodeURIComponent(form.dataset.projectId)}/organize-memory`, 'POST', {
        ...values,
        requestId: form.dataset.requestId,
      });
      closeModal();
      location.hash = '#tasks';
      toast('记忆整理已开始');
    } catch (error) {
      toast(error.message);
    } finally {
      submit.disabled = false;
    }
    return;
  }
  if (form.id !== 'dialog-form' && form.id !== 'memory-entry-form') return;
  const kind = form.dataset.kind,
    id = form.dataset.id;
  if (kind === 'project-invite') {
    if (!values.employeeId) return toast('请选择数字员工');
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = '正在添加…';
    try {
      acceptServer(
        await request(`/projects/${owner.id}/groups/${id}/employees`, 'POST', {
          employeeId: values.employeeId,
        }),
      );
      closeModal();
      render();
      toast('数字员工已加入飞书群');
    } catch (error) {
      toast(error.message);
    } finally {
      submit.disabled = false;
      submit.textContent = '确认添加到飞书群';
    }
    return;
  }
  if (kind === 'task') {
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await request('/tasks', 'POST', values);
      closeModal();
      await refreshTasks();
      toast('任务已提交到本机队列');
    } catch (error) {
      toast(error.message);
    } finally {
      submit.disabled = false;
    }
    return;
  }
  if (kind === 'memory-info') {
    for (const [name, value] of Object.entries(values))
      $('#memory-entry-form').elements[name].value = value.trim();
    dirty = true;
    $('#save-state').textContent = '有未保存的修改';
    closeModal();
    return;
  }
  for (const key of Object.keys(values)) if (key !== 'content') values[key] = values[key].trim();
  if (kind === 'employee') {
    if (!values.name) return toast('请填写名称');
    const item = initialEmployee(uid(), values.name, values.description);
    data.employees.push(item);
    closeModal();
    if (await commit('员工已创建')) {
      history.pushState(null, '', `#employees/${item.id}/basic`);
      render();
    }
    return;
  }
  if (kind === 'project') {
    if (!values.name) return toast('请填写名称');
    if (id) Object.assign(owner, values);
    else
      data.projects.push({
        id: uid(),
        ...values,
        memories: [],
        employees: [],
        groups: [],
        members: [],
      });
  }
  if (kind === 'store' || kind === 'memory') {
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      if (kind === 'store') {
        form.dataset.requestId ||= uid();
        const result = await request(
          `${memoryApiBase()}/stores${id ? '/' + encodeURIComponent(id) : ''}`,
          'POST',
          { ...values, requestId: form.dataset.requestId },
        );
        acceptServer(result);
      } else {
        const existing = owner.memories.find((m) => m.id === id);
        if (existing && existing.storeId !== values.storeId)
          throw new Error('暂不支持跨记忆库移动，请在目标库新增条目后处理原条目');
        const result = await request(
          `${memoryApiBase()}/entries${id ? '/' + encodeURIComponent(id) : ''}`,
          'POST',
          { ...values, sha: existing?.sha },
        );
        selectedMemoryStore = values.storeId;
        selectedMemoryEntry = result.id;
      }
      dirty = false;
      closeModal();
      loadedMemoryKey = '';
      await refreshRemoteMemory();
      toast('已保存到 MA');
    } catch (error) {
      toast(error.message);
    } finally {
      submit.disabled = false;
    }
    return;
  }
  if (kind === 'credential') {
    if (!values.name || !values.reference) return toast('请填写名称与引用标识');
    if (!/^(credential|vault):\/\/[a-zA-Z0-9/_-]+$/.test(values.reference))
      return toast('请填写 credential:// 或 vault:// 开头的引用，不要输入密钥');
    owner.credentials.push({ id: uid(), ...values });
  }
  if (kind === 'publish') {
    if (!values.note) return toast('请填写版本说明');
    const version = {
      id: uid(),
      number: Math.max(0, ...owner.versions.map((v) => v.number)) + 1,
      note: values.note,
      createdAt: new Date().toISOString(),
      snapshot: snapshot(owner),
    };
    owner.versions.push(version);
    owner.activeVersion = version.id;
  }
  closeModal();
  commit(kind === 'publish' ? '本地版本已发布' : '已保存');
});
function startPathRename() {
  const input = $('#memory-path-input');
  if (!input) return;
  input.readOnly = false;
  input.value = $('#memory-entry-form').elements.path.value;
  input.focus();
  input.select();
}
document.addEventListener('dblclick', (event) => {
  if (event.target.id === 'memory-path-input') startPathRename();
});
document.addEventListener('keydown', (event) => {
  if (event.target.id !== 'memory-path-input') return;
  if (event.key === 'F2') {
    event.preventDefault();
    startPathRename();
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    $('#memory-entry-form').requestSubmit();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    const entry = context().owner.memories.find((item) => item.id === selectedMemoryEntry);
    $('#memory-entry-form').elements.path.value = entry.path;
    event.target.value = entry.path.split('/').at(-1);
    event.target.readOnly = true;
    $('#memory-document-path').textContent = '/' + entry.path;
  }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'environment-search') {
    const current = $('#employee-form').elements.maEnvironmentId.value;
    $('#environment-select').innerHTML = environmentSelect(
      environmentChoices.get(route().id),
      current,
      event.target.value,
    );
    return;
  }
  if (event.target.id === 'memory-path-input') {
    $('#memory-entry-form').elements.path.value = event.target.value;
    $('#memory-document-path').textContent = '/' + event.target.value;
    dirty = true;
    $('#save-state').textContent = '有未保存的修改';
    return;
  }
  if (event.target.matches('.memory-direct-text')) {
    $('#memory-line-numbers').textContent = event.target.value
      .split('\n')
      .map((_, i) => i + 1)
      .join('\n');
  }
  if (event.target.id === 'search') {
    search = event.target.value;
    applyFilters();
  } else if (event.target.closest('#employee-form, #memory-entry-form')) {
    dirty = true;
    if ($('#save-state')) $('#save-state').textContent = '有未保存的修改';
  }
});
document.addEventListener(
  'scroll',
  (event) => {
    if (event.target.matches?.('.memory-direct-text'))
      $('#memory-line-numbers').scrollTop = event.target.scrollTop;
  },
  true,
);
document.addEventListener('change', (event) => {
  if (event.target.name === 'maEnvironmentId') {
    const item = environmentChoices.get(route().id)?.environments?.find((e) => e.id === event.target.value);
    if ($('#environment-note')) $('#environment-note').textContent = environmentNote(item);
  }
  if (event.target.name === 'typeFilter') {
    typeFilter = event.target.value;
    applyFilters();
  }
  if (event.target.name === 'statusFilter') {
    statusFilter = event.target.value;
    applyFilters();
  }
});
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (link && dirty && !confirm('有未保存的修改，确定离开吗？')) event.preventDefault();
});
window.addEventListener('beforeunload', (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('hashchange', () => {
  selectedMemoryStore = '';
  selectedMemoryEntry = '';
  editingMemory = false;
  dirty = false;
  search = '';
  statusFilter = 'all';
  typeFilter = 'all';
  closeModal();
  render();
  window.scrollTo(0, 0);
});
let pollingTasks = false;
let taskRenderPending = false;
async function refreshTasks() {
  if (pollingTasks || !connected) return;
  pollingTasks = true;
  try {
    const result = await request('/tasks');
    const changed = JSON.stringify(data.tasks) !== JSON.stringify(result.tasks);
    taskRenderPending ||= changed;
    data.tasks = result.tasks;
    if (confirmedData) confirmedData.tasks = copy(result.tasks);
    if (
      taskRenderPending &&
      route().module === 'tasks' &&
      !$('#modal').open &&
      !document.querySelector('.select-menu:popover-open') &&
      !document.activeElement?.matches('input, [role="combobox"]')
    ) {
      render();
      taskRenderPending = false;
    }
  } finally {
    pollingTasks = false;
  }
}
setInterval(() => {
  if (connected && !saving && route().module === 'tasks')
    refreshTasks().catch(() => {
      $('#workspace-status').textContent = '任务更新失败，请检查本机服务';
      $('#workspace-status').className = 'pill amber';
    });
}, 2000);
window.addEventListener('focus', () => {
  if (connected && !$('#ma-config-form')) void refreshMaStatus();
});
connectWorkspace();

document.addEventListener('change', (event) => {
  if (event.target.name === 'groupProjectFilter') {
    groupProjectFilter = event.target.value;
    render();
  }
  if (event.target.name === 'groupEmployeeFilter') {
    groupEmployeeFilter = event.target.value;
    render();
  }
});

let pollingGroups = false;
async function refreshGroupScene() {
  const visible = () =>
    route().module === 'groups' || (route().module === 'projects' && route().section === 'groups');
  const busy = () =>
    dirty ||
    saving ||
    $('#modal').open ||
    document.activeElement?.matches('input, textarea, [role="combobox"]');
  if (pollingGroups || !connected || !visible() || busy()) return;
  pollingGroups = true;
  const revision = serverRevision;
  try {
    const result = await request('');
    if (!visible() || busy() || revision !== serverRevision) return;
    if (result.revision !== serverRevision) {
      acceptServer(result);
      render();
    }
  } catch {
    $('#workspace-status').textContent = '群聊同步失败，将自动重试';
  } finally {
    pollingGroups = false;
  }
}
setInterval(() => void refreshGroupScene(), 2000);
window.addEventListener('focus', () => void refreshGroupScene());
