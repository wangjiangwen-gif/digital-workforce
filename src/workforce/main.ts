import { MaInitializer } from './ma-initializer.ts';
import { MemoryScheduler } from './memory-scheduler.ts';
import { MaEnvironments, RECOMMENDED_ENVIRONMENT_NAME } from './ma-environments.ts';
import { SessionMemory } from './session-memory.ts';
import { MemoryOrganizer } from './memory-organizer.ts';
import { MaMemoryApi } from './ma-memory.ts';
import { WorkspaceMemories } from './workspace-memories.ts';
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Workforce, MemoryWorker } from './domain.ts';
import { createWeb, saveAccessToken } from './web.ts';
import { GatewayStore } from '../store.ts';
import { ArkClient } from '../ark.ts';
import { MaExtractor } from './extractor.ts';
import { LocalWorkspace } from './workspace.ts';
import { WorkspaceChannels } from './channels.ts';
import { MaConfiguration } from './ma-config.ts';
import { migrateLocalSkills } from './ma-skills.ts';
import { FeishuGroups } from './feishu-groups.ts';

const dataDir = resolve(process.env.WORKFORCE_DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lock = new GatewayStore(resolve(dataDir, 'web-lock.db'));
lock.acquireRuntimeLock();
const w = new Workforce(resolve(dataDir, 'workforce.db'));
const workspace = new LocalWorkspace(resolve(dataDir, 'workspace.db'));
migrateLocalSkills(workspace);
const maConfig = new MaConfiguration(dataDir);
const memories = new WorkspaceMemories(workspace, new MaMemoryApi(maConfig));
const environments = new MaEnvironments(workspace, memories.api, () =>
  new ArkClient(maConfig.apiKey()!, 'https://ark.cn-beijing.volces.com/api/v3').createEnvironment(
    RECOMMENDED_ENVIRONMENT_NAME,
    '',
  ),
);
const channels = new WorkspaceChannels(workspace, { dataDir });
channels.environments = environments;
const sessionMemory = new SessionMemory(workspace, memories.api);
const organizer = new MemoryOrganizer(memories, sessionMemory, (id) => channels.runtimeConfig(id));
channels.organizer = organizer;
channels.memories = memories;
const tokenPath = resolve(dataDir, 'admin-token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600 });
saveAccessToken(w, { id: 'admin', role: 'admin' }, readFileSync(tokenPath, 'utf8').trim());
w.recoverJobs();
let worker = new MemoryWorker(w);
let extractorMode = 'explicit-confirmation';
if (process.env.WORKFORCE_EXTRACTOR_CONFIG) {
  const path = resolve(process.env.WORKFORCE_EXTRACTOR_CONFIG);
  const rel = relative(process.cwd(), path);
  if (rel.startsWith('..') || rel.startsWith('/') || statSync(path).mode & 0o077)
    throw new Error('提炼配置须位于当前项目内并使用600权限');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (
    config.dedicatedExtractor !== true ||
    typeof config.apiKey !== 'string' ||
    !config.apiKey ||
    config.apiKey.includes('REPLACE_')
  )
    throw new Error('须配置独立后台提炼Agent及密钥');
  const adapter = new MaExtractor(
    w,
    new ArkClient(config.apiKey, 'https://ark.cn-beijing.volces.com/api/v3'),
    config,
  );
  worker = new MemoryWorker(w, (turns, job) => adapter.extract(turns, job));
  extractorMode = 'dedicated-ma-candidate-filter';
}
const port = Number(process.env.WORKFORCE_PORT || '8790');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WORKFORCE_PORT 无效');
const initializer = new MaInitializer(workspace, maConfig, channels, memories);
const { server, url } = await createWeb(w, {
  initializer,
  port,
  publicOrigin: process.env.WORKFORCE_PUBLIC_ORIGIN,
  extractorMode,
  workspace,
  channels,
  feishuGroups: new FeishuGroups(workspace, channels),
  maConfig,
  memories,
  organizer,
  environments,
});
channels.resume();
const memoryScheduler = new MemoryScheduler(workspace, organizer, sessionMemory);
memoryScheduler.start();
const taskInterval = setInterval(() => {
  try {
    workspace.tick();
  } catch (error) {
    console.error('本地任务执行失败：', error);
  }
}, 2000);
let ticking = false;
const interval = setInterval(() => {
  if (ticking) return;
  ticking = true;
  worker
    .tick()
    .catch(() => console.error('后台记忆轮询失败，请检查数据库'))
    .finally(() => {
      ticking = false;
    });
}, 1000);
console.log(
  `数字员工本机工作台：${url}\n工作台数据：${resolve(dataDir, 'workspace.db')}\n飞书 Channel 按已绑定员工启动；任务页的手动任务仍执行本地上下文快照。`,
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  clearInterval(taskInterval);
  memoryScheduler.stop();
  await organizer.stop();
  await channels.stop();
  server.close(() => {
    w.close();
    workspace.close();
    lock.close();
    process.exit(0);
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
