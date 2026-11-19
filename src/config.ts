/** 配置只取自显式环境变量与 Zotero 标准目录，不修改 Zotero 的偏好设置。 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { localOrigin } from './adapters/api/index.js';

export interface Config {
  mode: 'auto' | 'api' | 'database';
  apiOrigin: string;
  dataDirectory: string;
  linkedRoots: string[];
  apiTimeoutMs: number;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    mode: z.enum(['auto', 'api', 'database']).parse(env.ZOTERO_MODE ?? 'auto'),
    apiOrigin: localOrigin(env.ZOTERO_API_ORIGIN ?? 'http://127.0.0.1:23119'),
    dataDirectory: resolve(env.ZOTERO_DATA_DIR ?? join(homedir(), 'Zotero')),
    linkedRoots: z.array(z.string().min(1)).parse(JSON.parse(env.ZOTERO_LINKED_ROOTS ?? '[]')).map(p => resolve(p)),
    apiTimeoutMs: z.coerce.number().int().min(100).max(30000).parse(env.ZOTERO_API_TIMEOUT_MS ?? '5000'),
  };
}
