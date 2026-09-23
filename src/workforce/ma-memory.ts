import { DomainError } from './domain.ts';
import type { MaConfiguration } from './ma-config.ts';

export class MaMemoryApi {
  constructor(privateConfig: Pick<MaConfiguration, 'apiKey'>, fetcher = fetch) {
    this.config = privateConfig;
    this.fetcher = fetcher;
  }
  private config: Pick<MaConfiguration, 'apiKey'>;
  private fetcher: typeof fetch;
  async call(path: string, method = 'GET', body?: unknown): Promise<any> {
    const key = this.config.apiKey();
    if (!key) throw new DomainError('请先配置并验证方舟 API Key');
    let response: Response;
    try {
      response = await this.fetcher(`https://ark.cn-beijing.volces.com/api/v3${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new DomainError('MA 记忆请求结果未确认，请刷新核查后重试', 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError(`MA 记忆请求失败（HTTP ${response.status}）`, response.status);
    }
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch {
      throw new DomainError('MA 记忆响应无效，请刷新核查结果', 502);
    }
  }
  private id(id: string) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new DomainError('MA 记忆 ID 无效');
    return encodeURIComponent(id);
  }
  private storePath(id: string) {
    return `/memory_stores/${this.id(id)}`;
  }
  async all(path: string) {
    const items: any[] = [],
      seen = new Set<string>();
    let page = '';
    do {
      const result = await this.call(
        `${path}${path.includes('?') ? '&' : '?'}limit=100${page ? `&page=${encodeURIComponent(page)}` : ''}`,
      );
      if (!Array.isArray(result.data)) throw new DomainError('MA 记忆列表响应无效', 502);
      items.push(...result.data);
      page = result.next_page || '';
      if (page && seen.has(page)) throw new DomainError('MA 记忆分页游标重复', 502);
      seen.add(page);
      if (seen.size > 100) throw new DomainError('MA 记忆分页超出限制', 502);
    } while (page);
    return items;
  }
  stores() {
    return this.all('/memory_stores');
  }
  createStore(name: string, description: string, metadata: Record<string, string>) {
    this.validateStore(name, description);
    return this.call('/memory_stores', 'POST', { name, description, metadata });
  }
  updateStore(id: string, name: string, description: string) {
    this.validateStore(name, description);
    return this.call(this.storePath(id), 'POST', { name, description });
  }
  private validateStore(name: string, description: string) {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 64 ||
      typeof description !== 'string' ||
      description.length > 2048
    )
      throw new DomainError('记忆库名称须为 1–64 字，描述不超过 2048 字');
  }
  getStore(id: string) {
    return this.call(this.storePath(id));
  }
  deleteStore(id: string) {
    return this.call(this.storePath(id), 'DELETE');
  }
  entries(id: string) {
    return this.all(`${this.storePath(id)}/memories`);
  }
  getEntry(store: string, id: string) {
    return this.call(`${this.storePath(store)}/memories/${this.id(id)}`);
  }
  createEntry(store: string, path: string, content: string) {
    return this.call(`${this.storePath(store)}/memories`, 'POST', this.entryBody(path, content));
  }
  updateEntry(store: string, id: string, path: string, content: string) {
    return this.call(
      `${this.storePath(store)}/memories/${this.id(id)}`,
      'POST',
      this.entryBody(path, content),
    );
  }
  deleteEntry(store: string, id: string) {
    return this.call(`${this.storePath(store)}/memories/${this.id(id)}`, 'DELETE');
  }
  private entryBody(path: string, content: string) {
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > 1024 ||
      /[\\\x00-\x1f]/.test(path) ||
      path
        .replace(/^\//, '')
        .split('/')
        .some((p) => !p || p === '.' || p === '..')
    )
      throw new DomainError('请输入有效的记忆条目路径');
    if (!/\.(md|txt)$/.test(path)) throw new DomainError('MA 记忆条目仅支持 .md 或 .txt 后缀');
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 100 * 1024)
      throw new DomainError('记忆文本不能超过 100 KB');
    return { path: '/' + path.replace(/^\//, ''), content };
  }
}
