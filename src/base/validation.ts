/** 模型、HTTP、配置和数据库均在入口校验，内部统一使用同一种文献结构。 */
import { z } from 'zod';
import type { LibraryId } from './types.js';
import { ZoteroError } from './errors.js';
export const librarySchema = z.string().regex(/^(user:0|group:[1-9]\d*)$/)
  .refine(value => value === 'user:0' || Number.isSafeInteger(Number(value.slice(6))), '群组编号必须是可精确表示的正整数。')
  .transform(value => value as LibraryId);
/** 直接导入 core 的调用也需检查，防止绕过 MCP/HTTP 校验后错读其他库。 */
export function parseLibraryId(value: unknown): LibraryId {
  const parsed = librarySchema.safeParse(value);
  if (!parsed.success) throw new ZoteroError('invalid_library', '文库编号必须为 user:0 或有效的 group:正整数。');
  return parsed.data;
}
export const keySchema = z.string().regex(/^[A-Z0-9]{8}$/);
export const refSchema = z.object({ library: librarySchema.default('user:0'), key: keySchema });
export const itemDataSchema = z.object({
  key: keySchema, itemType: z.string(), title: z.string().optional(), version: z.number().optional(),
  creators: z.array(z.object({
    firstName: z.string().optional(), lastName: z.string().optional(),
    name: z.string().optional(), creatorType: z.string().optional(),
  })).optional(),
  tags: z.array(z.object({ tag: z.string() })).optional(),
  collections: z.array(keySchema).optional(), parentItem: keySchema.optional(),
}).passthrough();
