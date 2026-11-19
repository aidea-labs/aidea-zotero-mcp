/** 原目录仅以只读文件句柄复制，SQLite 恢复只发生在本服务的临时副本中。 */
import { constants } from 'node:fs';
import { open, lstat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ZoteroError } from '../../base/errors.js';

const names = ['zotero.sqlite', 'zotero.sqlite-wal', 'zotero.sqlite-journal'];
async function fingerprints(directory: string) {
  return Promise.all(names.map(async name => {
    try {
      const value = await lstat(join(directory, name), { bigint: true });
      if (!value.isFile() || value.isSymbolicLink()) throw new ZoteroError('invalid_database', '文库文件必须为普通文件。');
      if (value.size > 2n * 1024n ** 3n) throw new ZoteroError('database_too_large', '单个数据库文件超过本版 2 GiB 上限。');
      return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && name !== 'zotero.sqlite') return null;
      throw error;
    }
  }));
}
export async function snapshot(directory: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const folder = await mkdtemp(join(tmpdir(), 'aidea-zotero-'));
    try {
      const before = await fingerprints(directory);
      for (const [index, name] of names.entries()) {
        if (!before[index]) continue;
        const source = await open(join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const destination = await open(join(folder, name), 'wx', 0o600);
          try {
            const initial = await source.stat({ bigint: true });
            const stamp = [initial.dev, initial.ino, initial.size, initial.mtimeNs, initial.ctimeNs].join(':');
            if (stamp !== before[index]) throw new ZoteroError('database_changed', '复制期间文库变化，请重试。');
            const buffer = Buffer.alloc(1024 * 1024);
            let position = 0;
            while (position < Number(initial.size)) {
              signal.throwIfAborted();
              const count = await source.read(buffer, 0, Math.min(buffer.length, Number(initial.size) - position), position);
              if (!count.bytesRead) throw new ZoteroError('database_changed', '复制期间文库变化，请重试。');
              let written = 0;
              while (written < count.bytesRead) {
                const row = await destination.write(buffer, written, count.bytesRead - written, position + written);
                if (!row.bytesWritten) throw new ZoteroError('snapshot_failed', '无法写入文库副本。');
                written += row.bytesWritten;
              }
              position += count.bytesRead;
            }
            await destination.sync();
          } finally { await destination.close(); }
        } finally { await source.close(); }
      }
      const after = await fingerprints(directory);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new ZoteroError('database_changed', '复制期间文库变化，请重试。');
      return { folder, file: join(folder, 'zotero.sqlite'), identity: directory + ':' + before[0]!.split(':').slice(0, 2).join(':') };
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      signal.throwIfAborted();
      if (!(error instanceof ZoteroError) || error.code !== 'database_changed' || attempt === 2) throw error;
    }
  }
  throw new ZoteroError('snapshot_failed', '无法取得稳定的文库副本。');
}
