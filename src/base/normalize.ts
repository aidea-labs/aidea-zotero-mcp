/** 把 API 的原始记录转换为数据库 adapter 也能生成的统一 Item。 */
import type { Item, LibraryId } from './types.js';
import { itemDataSchema } from './validation.js';
export function normalizeItem(input: unknown, library: LibraryId): Item {
  const data = itemDataSchema.parse(input);
  const fields = Object.fromEntries(Object.entries(data).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'));
  return {
    ref: { library, key: data.key }, type: data.itemType, title: data.title ?? '', fields,
    creators: (data.creators ?? []).map(c => ({
      firstName: c.firstName ?? '', lastName: c.lastName ?? '', name: c.name ?? '',
      role: c.creatorType ?? 'author',
    })),
    tags: (data.tags ?? []).map(tag => tag.tag),
    collections: data.collections ?? [], parentKey: data.parentItem ?? null,
    version: data.version ?? null,
  };
}
export function itemYear(item: Item): number | null {
  const match = /\b(\d{4})\b/.exec(item.fields.date ?? '');
  return match ? Number(match[1]) : null;
}
export function normalizeDoi(value: string): string {
  return value.trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, '').toLowerCase();
}
export function citationKey(item: Item): string {
  return item.fields.citationKey
    || /^Citation Key:\s*(.+)$/mi.exec(item.fields.extra ?? '')?.[1]?.trim()
    || 'zotero_' + item.ref.library.replace(':', '_') + '_' + item.ref.key;
}
