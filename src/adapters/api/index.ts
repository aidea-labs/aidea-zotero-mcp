/** 只访问配置中的本机 Zotero Local API，禁止自动跳到云端或跟随附件重定向。 */
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Adapter, Attachment, Collection, Item, ItemRef, LibraryId, Note, Source } from '../../base/types.js';
import { normalizeItem } from '../../base/normalize.js';
import { ZoteroError } from '../../base/errors.js';
import { readableFile } from '../../base/files.js';

const responseItem = z.object({ key: z.string(), data: z.record(z.string(), z.unknown()) });
const itemList = z.array(responseItem);
const MAX_RESPONSE = 8 * 1024 * 1024;

export function localOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ZoteroError('invalid_api_origin', 'API 地址必须是本机 HTTP 服务的 origin。');
  }
  return url.origin;
}
function prefix(library: LibraryId): string {
  const [type, id] = library.split(':');
  return '/api/' + (type === 'user' ? 'users/' : 'groups/') + id;
}
export class ApiAdapter implements Adapter {
  source: Source;
  readonly origin: string;
  private constructor(origin: string, identity: string, private readonly timeoutMs: number) {
    this.origin = origin;
    this.source = { backend: 'api', identity, observedAt: new Date().toISOString() };
  }
  static async connect(origin: string, signal: AbortSignal, timeoutMs = 5000) {
    const adapter = new ApiAdapter(localOrigin(origin), '', timeoutMs);
    const { response } = await adapter.request('/api/', signal);
    const version = response.headers.get('Zotero-API-Version');
    if (version !== '3') throw new ZoteroError('unsupported_api', '本机服务没有返回 Zotero API v3 标识。');
    adapter.source.identity = response.headers.get('Zotero-Server-ID') ?? adapter.origin;
    return adapter;
  }
  private async request(path: string, signal: AbortSignal, redirectAllowed = false) {
    let response: Response;
    try {
      response = await fetch(this.origin + path, {
        redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        // 本机服务可随时退出。避免下一次探测复用旧连接，误把已关闭判为网络异常。
        headers: { 'Zotero-API-Version': '3', Connection: 'close',
          ...(this.source.identity && this.source.identity !== this.origin ? { 'Zotero-Server-ID': this.source.identity } : {}) },
      });
    } catch (error) {
      signal.throwIfAborted();
      const cause = (error as { cause?: { code?: string } }).cause;
      if (cause?.code === 'ECONNREFUSED') throw new ZoteroError('api_not_listening', '本机 Zotero API 未监听。');
      throw new ZoteroError('api_timeout_or_network', '本机 Zotero API 超时或连接异常，请稍后重试。');
    }
    if (redirectAllowed && [301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      return { response, text: '' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      const descriptions: Record<number, [string, string]> = {
        403: ['api_disabled', '请在 Zotero 高级设置中允许本机应用访问。'],
        404: ['item_missing', '找不到所选条目或附件。'],
        412: ['source_changed', 'Zotero 文库已切换，请重新搜索。'],
      };
      const [code, message] = descriptions[response.status]
        ?? ['api_error', 'Zotero API 返回 HTTP ' + response.status + '，请重试。'];
      throw new ZoteroError(code, message);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE) throw new ZoteroError('response_too_large', 'Zotero 返回内容超过 8 MiB，请缩小范围。');
          chunks.push(chunk);
        }
      }
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return { response, text: Buffer.concat(chunks).toString('utf8') };
  }
  private async json(path: string, signal: AbortSignal): Promise<unknown> {
    const { text } = await this.request(path, signal);
    try { return JSON.parse(text); }
    catch { throw new ZoteroError('invalid_api_response', 'Zotero 返回了无法解析的数据。'); }
  }
  async collections(library: LibraryId, signal: AbortSignal): Promise<Collection[]> {
    const schema = z.array(z.object({ key: z.string(), data: z.object({
      name: z.string(), parentCollection: z.union([z.string(), z.literal(false)]).optional(),
    }) }));
    const output: Collection[] = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const rows = schema.parse(await this.json(prefix(library) + '/collections?limit=100&start=' + offset, signal));
      output.push(...rows.map(row => ({ key: row.key, name: row.data.name, parentKey: row.data.parentCollection || null })));
      if (rows.length < 100) return output;
    }
    throw new ZoteroError('collections_limit', '集合超过读取上限，请缩小文库范围。');
  }
  async *items(library: LibraryId, collection: string | undefined, signal: AbortSignal): AsyncIterable<Item> {
    let offset = 0;
    while (true) {
      const route = prefix(library) + (collection ? '/collections/' + collection + '/items/top' : '/items/top');
      // 本机 API 支持 dateAdded，不支持按条目 key 排序。使用同一排序读取各页。
      const rows = itemList.parse(await this.json(route + '?format=json&sort=dateAdded&direction=asc&limit=100&start=' + offset, signal));
      for (const row of rows) {
        signal.throwIfAborted();
        const item = normalizeItem({ ...row.data, key: row.key }, library);
        if (!['attachment', 'note', 'annotation'].includes(item.type)) yield item;
      }
      if (rows.length < 100) return;
      offset += rows.length;
    }
  }
  async item(ref: ItemRef, signal: AbortSignal): Promise<Item> {
    const result = responseItem.parse(await this.json(prefix(ref.library) + '/items/' + ref.key, signal));
    return normalizeItem({ ...result.data, key: result.key }, ref.library);
  }
  private async children(ref: ItemRef, signal: AbortSignal): Promise<Item[]> {
    const rows: Item[] = [];
    let offset = 0;
    while (offset < 1000) {
      const next = itemList.parse(await this.json(prefix(ref.library) + '/items/' + ref.key + '/children?limit=100&start=' + offset, signal));
      rows.push(...next.map(row => normalizeItem({ ...row.data, key: row.key }, ref.library)));
      if (next.length < 100) return rows;
      offset += next.length;
    }
    throw new ZoteroError('children_limit', '子条目超过 1000，请缩小范围。');
  }
  async attachments(ref: ItemRef, signal: AbortSignal): Promise<Attachment[]> {
    const item = await this.item(ref, signal);
    const rows = item.type === 'attachment' ? [item] : await this.children(ref, signal);
    const attachments: Attachment[] = [];
    for (const row of rows.filter(item => item.type === 'attachment')) {
      let path: string | null = null;
      const mode = row.fields.linkMode ?? '';
      if (mode !== 'linked_url') {
        try {
          const { response } = await this.request(prefix(ref.library) + '/items/' + row.ref.key + '/file', signal, true);
          const location = response.headers.get('Location');
          if (location) {
            const url = new URL(location, this.origin);
            if (url.protocol === 'file:' && !url.hostname) path = await readableFile(fileURLToPath(url));
            else throw new ZoteroError('attachment_not_local', '附件尚未下载到本机。');
          }
        } catch (error) {
          // 条目已存在而 file 返回404时，附件元数据仍可列出，实际获取再报未下载。
          if (!(error instanceof ZoteroError) || error.code !== 'item_missing') throw error;
        }
      }
      attachments.push({ ref: row.ref, parentKey: row.parentKey, title: row.title,
        mimeType: row.fields.contentType ?? '', linkMode: mode, path, available: path !== null });
    }
    return attachments;
  }
  async notes(ref: ItemRef, signal: AbortSignal): Promise<Note[]> {
    const parent = await this.item(ref, signal);
    if (['note', 'attachment', 'annotation'].includes(parent.type)) {
      throw new ZoteroError('parent_required', '请提供母文献条目。');
    }
    return (await this.children(ref, signal)).filter(row => row.type === 'note').map(row => ({
      ref: row.ref, parentKey: ref.key, format: 'html', content: row.fields.note ?? '',
    }));
  }
  async close() {}
}
