/** 文件读取保持本地、只读、有界，并拒绝路径穿越与重定向的软链接。 */
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { ZoteroError } from './errors.js';

export const MAX_PDF_BYTES = 32 * 1024 * 1024;
export function within(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}
export async function readableFile(file: string): Promise<string | null> {
  try {
    const actual = await realpath(file);
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return (await handle.stat()).isFile() ? actual : null; }
    finally { await handle.close(); }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw new ZoteroError('file_unreadable', '无法读取附件，请检查文件权限。');
  }
}
export async function readPdf(file: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (await realpath(file) !== file) throw new ZoteroError('file_changed', '附件路径已重定向，请重新获取。');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_PDF_BYTES) {
      throw new ZoteroError('pdf_size_limit', 'PDF 超过本次 32 MiB 读取上限，或文件类型不可读。');
    }
    // 按已检查的长度读取，文件增长时也不会先分配无限内存。
    const data = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < data.length) {
      signal.throwIfAborted();
      const row = await handle.read(data, offset, data.length - offset, offset);
      if (!row.bytesRead) throw new ZoteroError('file_changed', 'PDF 在读取期间发生变化，请重新获取。');
      offset += row.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new ZoteroError('file_changed', 'PDF 在读取期间发生变化，请重新获取。');
    }
    if (!data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new ZoteroError('invalid_pdf', '所选附件不是可识别的 PDF。');
    }
    return new Uint8Array(data);
  } finally { await handle.close(); }
}
