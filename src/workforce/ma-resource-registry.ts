import { DomainError } from './domain.ts';
import type { LocalWorkspace } from './workspace.ts';
import type { MaMemoryApi } from './ma-memory.ts';

// 每个 Key 独立保存创建回执；网络超时保留 pending，不通过重复 POST 猜测结果。
export class MaResourceRegistry {
  constructor(workspace: LocalWorkspace, scope: string, api: Pick<MaMemoryApi, 'call'>) {
    this.workspace = workspace;
    this.scope = scope;
    this.api = api;
    workspace.db.exec(
      'CREATE TABLE IF NOT EXISTS workspace_ma_resources (scope TEXT, name TEXT, payload TEXT NOT NULL, PRIMARY KEY(scope,name))',
    );
  }
  private workspace: LocalWorkspace;
  private scope: string;
  private api: Pick<MaMemoryApi, 'call'>;
  async ensure(
    name: string,
    path: string,
    known: string | undefined,
    create: () => Promise<any>,
    recover?: () => Promise<any>,
  ) {
    const row = this.workspace.db
      .prepare('SELECT payload FROM workspace_ma_resources WHERE scope=? AND name=?')
      .get(this.scope, name);
    const saved = row ? JSON.parse(String(row.payload)) : undefined;
    const save = (value: any) =>
      this.workspace.db
        .prepare('INSERT OR REPLACE INTO workspace_ma_resources VALUES(?,?,?)')
        .run(this.scope, name, JSON.stringify(value));
    if (saved?.pending && recover) {
      const found = await recover();
      if (found?.id) {
        save({ id: found.id });
        return { resource: found, created: false };
      }
    }
    if (saved?.pending) throw new DomainError(`${name} 上次创建结果未确认，请核查 MA，未重复创建`, 409);
    const id = saved?.id || known;
    if (id) {
      try {
        const raw = await this.api.call(`${path}/${encodeURIComponent(id)}`);
        const found = raw.data || raw;
        if (found.id !== id) throw new DomainError(`${name} 返回的资源 ID 不匹配`, 502);
        save({ id });
        return { resource: found, created: false };
      } catch (error) {
        if (!(error instanceof DomainError && error.status === 404)) throw error;
      }
    }
    if (recover) {
      const found = await recover();
      if (found?.id) {
        save({ id: found.id });
        return { resource: found, created: false };
      }
    }
    save({ pending: true });
    try {
      const raw = await create();
      const resource = raw.data || raw;
      if (!resource.id) throw new DomainError(`${name} 创建回执缺少 ID`, 502);
      save({ id: resource.id });
      return { resource, created: true };
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        [400, 401, 403, 404, 422, 429].includes(Number(error.status))
      )
        this.workspace.db
          .prepare('DELETE FROM workspace_ma_resources WHERE scope=? AND name=?')
          .run(this.scope, name);
      throw error;
    }
  }
}
