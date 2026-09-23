import { randomUUID } from 'node:crypto';
import { DomainError } from './domain.ts';
import type { LocalWorkspace } from './workspace.ts';
import { MaMemoryApi } from './ma-memory.ts';

export type MemoryOwner = 'employees' | 'projects';
export class WorkspaceMemories {
  private locks = new Map<string, Promise<any>>();
  workspace: LocalWorkspace;
  api: MaMemoryApi;
  constructor(workspace: LocalWorkspace, api: MaMemoryApi) {
    this.workspace = workspace;
    this.api = api;
    workspace.db
      .exec(`CREATE TABLE IF NOT EXISTS workspace_memory_links (key TEXT PRIMARY KEY, remote_id TEXT, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_memory_metadata (key TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
  }
  owner(kind: string, id: string) {
    if (!['employees', 'projects'].includes(kind)) throw new DomainError('记忆归属无效');
    const owner = this.workspace.read().state[kind].find((o: any) => o.id === id);
    if (!owner) throw new DomainError('记忆所属员工或项目不存在', 404);
    return owner;
  }
  async exclusive<T>(kind: string, id: string, work: () => Promise<T>): Promise<T> {
    const key = `${kind}:${id}`;
    const previous = this.locks.get(key) || Promise.resolve();
    const job = previous.catch(() => {}).then(work);
    this.locks.set(key, job);
    try {
      return await job;
    } finally {
      if (this.locks.get(key) === job) this.locks.delete(key);
    }
  }
  private updateOwner(kind: string, id: string, change: (owner: any) => void) {
    const latest = this.workspace.read();
    const owner = latest.state[kind].find((o: any) => o.id === id);
    if (!owner) throw new DomainError('记忆归属已被删除', 409);
    change(owner);
    return this.workspace.save(latest.state, latest.revision, true);
  }
  private key(kind: string, id: string, storeId: string) {
    return JSON.stringify([kind, id, storeId]);
  }
  private metadata(kind: string, id: string, entryId: string) {
    const row = this.workspace.db
      .prepare('SELECT payload FROM workspace_memory_metadata WHERE key=?')
      .get(this.key(kind, id, entryId)) as any;
    return row ? JSON.parse(row.payload) : {};
  }
  private saveMetadata(kind: string, id: string, entryId: string, input: any) {
    const payload = {
      title: String(input.title || '').slice(0, 500),
      source: String(input.source || '').slice(0, 500),
    };
    this.workspace.db
      .prepare('INSERT OR REPLACE INTO workspace_memory_metadata VALUES (?,?)')
      .run(this.key(kind, id, entryId), JSON.stringify(payload));
  }
  private async ensureStore(kind: string, id: string, store: any) {
    if (store.maStoreId) return store.maStoreId;
    if (
      typeof store.name !== 'string' ||
      !store.name.trim() ||
      store.name.length > 64 ||
      (store.description || '').length > 2048
    )
      throw new DomainError('记忆库名称须为 1–64 字，描述不超过 2048 字');
    const key = this.key(kind, id, store.id);
    const row = this.workspace.db.prepare('SELECT * FROM workspace_memory_links WHERE key=?').get(key) as any;
    if (row?.remote_id) return row.remote_id;
    const token = row?.token || randomUUID();
    if (row) {
      const matches = (await this.api.stores()).filter(
        (s: any) => s.metadata?.workforce_memory_token === token,
      );
      if (matches.length !== 1)
        throw new DomainError('上次记忆库创建结果未确认，请核查 MA；不会自动重复创建', 409);
      this.workspace.db
        .prepare('UPDATE workspace_memory_links SET remote_id=? WHERE key=?')
        .run(matches[0].id, key);
      return matches[0].id;
    }
    this.workspace.db.prepare('INSERT INTO workspace_memory_links VALUES (?,NULL,?)').run(key, token);
    let remote;
    try {
      remote = await this.api.createStore(store.name, store.description || '', {
        workforce_memory_token: token,
        workforce_owner: kind,
        workforce_owner_id: id,
      });
    } catch (error) {
      // 明确未受理的请求允许修正后重试；超时和服务端错误仍保留核查标记。
      if (error instanceof DomainError && [400, 401, 403, 404, 422, 429].includes(error.status))
        this.workspace.db
          .prepare('DELETE FROM workspace_memory_links WHERE key=? AND remote_id IS NULL')
          .run(key);
      throw error;
    }
    if (!remote.id?.startsWith('memstore-')) throw new DomainError('MA 未返回记忆库 ID', 502);
    this.workspace.db
      .prepare('UPDATE workspace_memory_links SET remote_id=? WHERE key=?')
      .run(remote.id, key);
    return remote.id;
  }
  migrate(kind: string, id: string) {
    return this.exclusive(kind, id, () => this.migrateOwner(kind, id));
  }
  private async migrateOwner(kind: string, id: string) {
    let owner = this.owner(kind, id);
    if (owner.memoryMode === 'ma') return this.workspace.read();
    // 修复旧社媒模板的 JSON 文件后缀；MA 仅接受 Markdown 或文本条目。
    if (
      owner.templateId === 'social-trends-weekly-v1' &&
      owner.memories.some((m: any) => m.path === 'config/dependencies.json')
    ) {
      this.updateOwner(kind, id, (o) => {
        for (const entry of o.memories.filter((m: any) => m.path === 'config/dependencies.json')) {
          if (o.memories.some((m: any) => m.storeId === entry.storeId && m.path === 'config/dependencies.md'))
            throw new DomainError('依赖契约的新旧路径同时存在，请核查后重试', 409);
          entry.path = 'config/dependencies.md';
        }
        if (typeof o.knowledge === 'string')
          o.knowledge = o.knowledge.replaceAll('config/dependencies.json', 'config/dependencies.md');
      });
      owner = this.owner(kind, id);
    }
    // 迁移中禁止普通保存改写旧内容；只有全部条目核验成功后才移除本地正文。
    this.updateOwner(kind, id, (o) => {
      o.memoryMigration = true;
    });
    const mapped = [];
    for (const store of owner.memoryStores) {
      const maStoreId = await this.ensureStore(kind, id, store);
      let entries = await this.api.entries(maStoreId);
      for (const entry of owner.memories.filter((m: any) => m.storeId === store.id)) {
        const path = '/' + entry.path.replace(/^\//, '');
        let remote = entries.find((m: any) => m.path === path);
        if (!remote) {
          remote = await this.api.createEntry(maStoreId, path, entry.content);
          entries.push(remote);
        }
        const detail = await this.api.getEntry(maStoreId, remote.id);
        if (detail.content !== entry.content)
          throw new DomainError(`MA 中 ${path} 与待迁移内容不同，请先核查，未覆盖远端`, 409);
        this.saveMetadata(kind, id, remote.id, entry);
      }
      mapped.push({ ...store, maStoreId, memoryCount: entries.length });
    }
    return this.updateOwner(kind, id, (o) => {
      o.memoryStores = mapped;
      o.memories = [];
      o.memoryMode = 'ma';
      delete o.memoryMigration;
    });
  }
  store(kind: string, id: string, storeId: string) {
    const owner = this.owner(kind, id);
    if (owner.memoryMode !== 'ma') throw new DomainError('请先将已有记忆迁移到 MA', 409);
    const store = owner.memoryStores.find((s: any) => s.id === storeId);
    if (!store?.maStoreId) throw new DomainError('MA 记忆库未关联', 404);
    return store;
  }
  async list(kind: string, id: string, storeId?: string) {
    const owner = this.owner(kind, id);
    if (owner.memoryMode !== 'ma')
      return { mode: 'legacy', stores: owner.memoryStores, entries: owner.memories };
    const stores = await Promise.all(
      owner.memoryStores.map(async (s: any) => {
        const remote = await this.api.getStore(s.maStoreId);
        return {
          ...s,
          name: remote.name,
          description: remote.description || '',
          memoryCount: remote.memory_count,
        };
      }),
    );
    const entries = storeId
      ? (await this.api.entries(this.store(kind, id, storeId).maStoreId))
          .filter((m: any) => m.type === 'memory')
          .map((m: any) => this.entryView(kind, id, storeId, m))
      : [];
    return { mode: 'ma', stores, entries };
  }
  private entryView(kind: string, id: string, storeId: string, m: any) {
    return {
      id: m.id,
      storeId,
      path: m.path.replace(/^\//, ''),
      ...this.metadata(kind, id, m.id),
      content: m.content,
      sha: m.content_sha256,
      updatedAt: m.updated_at,
    };
  }
  async detail(kind: string, id: string, storeId: string, entryId: string) {
    const result = await this.api.getEntry(this.store(kind, id, storeId).maStoreId, entryId);
    return this.entryView(kind, id, storeId, result);
  }
  saveStore(kind: string, id: string, input: any, storeId?: string) {
    return this.exclusive(kind, id, async () => {
      await this.migrateOwner(kind, id);
      const owner = this.owner(kind, id);
      const localId = storeId || input.requestId;
      if (typeof localId !== 'string' || !localId || localId.length > 128)
        throw new DomainError('创建记忆库需要请求标识');
      const current = owner.memoryStores.find((s: any) => s.id === localId);
      if (storeId && !current) throw new DomainError('记忆库不存在', 404);
      const maStoreId = current?.maStoreId || (await this.ensureStore(kind, id, { ...input, id: localId }));
      if (current) await this.api.updateStore(maStoreId, input.name, input.description || '');
      return this.updateOwner(kind, id, (o) => {
        const next = {
          id: localId,
          maStoreId,
          name: input.name,
          description: input.description || '',
          memoryCount: current?.memoryCount || 0,
        };
        const index = o.memoryStores.findIndex((s: any) => s.id === localId);
        if (index >= 0) o.memoryStores[index] = next;
        else o.memoryStores.push(next);
      });
    });
  }
  saveEntry(kind: string, id: string, input: any, entryId?: string, beforeWrite?: () => void) {
    return this.exclusive(kind, id, async () => {
      const store = this.store(kind, id, input.storeId);
      let result;
      if (entryId) {
        const before = await this.api.getEntry(store.maStoreId, entryId);
        if (!input.sha || before.content_sha256 !== input.sha)
          throw new DomainError('记忆已更新，请刷新后再编辑', 409);
        beforeWrite?.();
        result = await this.api.updateEntry(store.maStoreId, entryId, input.path, input.content);
      } else {
        try {
          beforeWrite?.();
          result = await this.api.createEntry(store.maStoreId, input.path, input.content);
        } catch (error) {
          if (!(error instanceof DomainError) || error.status !== 409) throw error;
          const match = (await this.api.entries(store.maStoreId)).find(
            (m: any) => m.path === '/' + input.path.replace(/^\//, ''),
          );
          if (!match || (await this.api.getEntry(store.maStoreId, match.id)).content !== input.content)
            throw error;
          result = match;
        }
      }
      this.saveMetadata(kind, id, result.id, input);
      return this.detail(kind, id, input.storeId, result.id);
    });
  }
  deleteStore(kind: string, id: string, storeId: string) {
    return this.exclusive(kind, id, async () => {
      const store = this.store(kind, id, storeId);
      await this.api.deleteStore(store.maStoreId);
      return this.updateOwner(kind, id, (o) => {
        o.memoryStores = o.memoryStores.filter((s: any) => s.id !== storeId);
      });
    });
  }
  deleteEntry(kind: string, id: string, storeId: string, entryId: string, sha: string) {
    return this.exclusive(kind, id, async () => {
      const store = this.store(kind, id, storeId);
      const current = await this.api.getEntry(store.maStoreId, entryId);
      if (!sha || current.content_sha256 !== sha) throw new DomainError('记忆已更新，请刷新后确认删除', 409);
      await this.api.deleteEntry(store.maStoreId, entryId);
      return { deleted: true };
    });
  }
}
