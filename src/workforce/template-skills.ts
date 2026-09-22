import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DomainError } from './domain.ts';
import { MaMemoryApi } from './ma-memory.ts';
import { MaResourceRegistry } from './ma-resource-registry.ts';
import { PLATFORM_SKILLS } from './skill-catalog.ts';
import type { LocalWorkspace } from './workspace.ts';
import type { MaConfiguration } from './ma-config.ts';

export type TemplateSkill = { name: string; tags: string[]; revision?: string };
async function uploadSkill(name: string, key: string) {
  if (!/^[a-z][a-z0-9-]+$/.test(name)) throw new DomainError('技能包名称无效');
  const directory = mkdtempSync(join(tmpdir(), 'workforce-skill-'));
  try {
    const zip = join(directory, `${name}.zip`);
    try {
      execFileSync('zip', ['-q', '-r', zip, name, '-x', '*/__pycache__/*', '*/test_*.py'], {
        cwd: resolve('skills'),
      });
    } catch {
      throw new DomainError('技能尚未上传：打包失败，请检查服务端 zip 命令和技能目录后重试', 400);
    }
    const body = new FormData();
    body.set('files', new Blob([readFileSync(zip)], { type: 'application/zip' }), `${name}.zip`);
    const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/skills', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError(`Skill 上传失败（HTTP ${response.status}）`, response.status);
    }
    const raw = await response.json();
    const uploaded = raw.data || raw;
    if (typeof uploaded.id !== 'string' || !/^skill-[a-zA-Z0-9_-]+$/.test(uploaded.id))
      throw new DomainError('Skill 上传回执缺少有效 ID，请核查 MA，避免重复上传', 502);
    return uploaded;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function ensureTemplateSkills(
  workspace: LocalWorkspace,
  config: MaConfiguration,
  specs: TemplateSkill[],
  note: (message: string) => void = () => {},
) {
  const key = config.apiKey();
  if (!key) throw new DomainError('请先配置方舟 API Key');
  const guard = () => {
    if (config.apiKey() !== key) throw new DomainError('API Key 已变化，停止初始化', 409);
    return key;
  };
  const api = new MaMemoryApi({ apiKey: guard });
  const registry = new MaResourceRegistry(workspace, createHash('sha256').update(key).digest('hex'), api);
  const skills = [];
  for (const spec of specs) {
    const catalog = config.platformSkills() || [];
    const known =
      catalog.find((s) => s.name === spec.name)?.id ||
      workspace
        .read()
        .state.employees.flatMap((e: any) => e.skills)
        .find((s: any) => s.name === spec.name)?.id ||
      PLATFORM_SKILLS.find((s) => s.name === spec.name)?.id;
    note(`正在核验 Skill：${spec.name}`);
    // 包修订使用独立回执，避免复用尚未包含新脚本的旧资源；旧资源保留。
    const result = await registry.ensure(
      `skill:${spec.name}${spec.revision ? ':' + spec.revision : ''}`,
      '/skills',
      spec.revision ? undefined : known,
      () => uploadSkill(spec.name, guard()),
      spec.revision
        ? undefined
        : async () => {
            const matches = (await api.all('/skills')).filter(
              (s: any) => s.name === spec.name && s.source === 'custom',
            );
            if (matches.length > 1)
              throw new DomainError(`技能 ${spec.name} 有多个同名资源，无法自动确认，请核查 MA`, 409);
            if (!matches.length) return undefined;
            const raw = await api.call(`/skills/${encodeURIComponent(matches[0].id)}`);
            const found = raw.data || raw;
            if (
              found.id !== matches[0].id ||
              found.name !== spec.name ||
              found.source !== 'custom' ||
              !/^\d+$/.test(String(found.latest_version))
            )
              throw new DomainError(`技能 ${spec.name} 的恢复核验未通过`, 502);
            guard();
            return found;
          },
    );
    // 先持久化创建回执，再回读；回读失败不丢 ID、不重复上传。
    const raw = result.created
      ? await api.call(`/skills/${encodeURIComponent(result.resource.id)}`)
      : result.resource;
    const skill = raw.data || raw;
    if (skill.name !== spec.name || skill.source !== 'custom' || !/^\d+$/.test(String(skill.latest_version)))
      throw new DomainError(`技能 ${spec.name} 的名称或版本不匹配`, 502);
    const normalized = {
      id: skill.id,
      name: spec.name,
      description: skill.description || '',
      version: String(skill.latest_version),
      source: 'ma',
      type: 'custom',
      enabled: true,
      tags: spec.tags,
    };
    skills.push(normalized);
    guard();
    // 每项成功立即登记，后续技能失败也不丢已完成回执；保留另一场景的目录。
    config.savePlatformSkills([
      ...catalog.filter((s) => s.name !== spec.name && s.id !== skill.id),
      { id: skill.id, name: spec.name, tags: spec.tags },
    ]);
    note(`${result.created ? '已上传' : '已复用'} Skill：${spec.name} · v${normalized.version}`);
  }
  return skills;
}
