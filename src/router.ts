/** 每次操作选择一种 adapter，操作中途失败不会换库后重放。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import type { Adapter } from './base/types.js';
import type { Config } from './config.js';
import { ZoteroError } from './base/errors.js';
import { ApiAdapter } from './adapters/api/index.js';
import { DatabaseAdapter } from './adapters/database/index.js';

const run = promisify(execFile);
export async function isZoteroRunning(signal: AbortSignal): Promise<boolean> {
  try {
    const windows = process.platform === 'win32';
    const { stdout } = await run(windows ? 'tasklist' : 'ps',
      windows ? ['/FO', 'CSV', '/NH'] : ['-axo', 'comm='], { signal, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.split(/\r?\n/).some(line => {
      const command = windows ? line.match(/^"([^"]+)"/)?.[1] ?? '' : line.trim();
      return /^(zotero|zotero-bin|zotero\.exe)$/i.test(basename(command));
    });
  } catch {
    signal.throwIfAborted();
    throw new ZoteroError('process_status_unknown', '无法确认 Zotero 是否运行，请明确选择 API 或数据库模式。');
  }
}
export type AdapterFactory = (signal: AbortSignal) => Promise<Adapter>;
export class AdapterRouter {
  private tail = Promise.resolve();
  constructor(private readonly config: Config, private readonly processCheck = isZoteroRunning,
    private readonly api: AdapterFactory = signal => ApiAdapter.connect(config.apiOrigin, signal, config.apiTimeoutMs),
    private readonly database: AdapterFactory = signal => DatabaseAdapter.connect(config.dataDirectory, config.linkedRoots, signal)) {}
  async select(signal: AbortSignal): Promise<Adapter> {
    if (this.config.mode === 'database') return this.database(signal);
    try { return await this.api(signal); }
    catch (error) {
      signal.throwIfAborted();
      if (this.config.mode === 'api' || !(error instanceof ZoteroError) || error.code !== 'api_not_listening') throw error;
      if (await this.processCheck(signal)) throw new ZoteroError('api_starting', 'Zotero 正在运行，但本机 API 尚未就绪，请检查设置或稍后重试。');
      return this.database(signal);
    }
  }
  /** 串行持有数据库副本，保证一个操作完成及关闭后才开始下一项。 */
  async use<T>(operation: (adapter: Adapter) => Promise<T>, signal: AbortSignal) {
    const previous = this.tail;
    const completed = Promise.withResolvers<void>();
    this.tail = completed.promise;
    await previous;
    try {
      signal.throwIfAborted();
      const adapter = await this.select(signal);
      try { return { source: adapter.source, value: await operation(adapter) }; }
      finally { await adapter.close(); }
    } finally { completed.resolve(); }
  }
}
