/** 读取 Zotero 数据库快照，按 library 与 key 共同定位，查询保留在 adapter 内。 */
import { DatabaseSync } from 'node:sqlite';
import { realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Adapter, ItemRef, LibraryId, Source, Attachment, Note, Collection } from '../../base/types.js';
import { normalizeItem } from '../../base/normalize.js';
import { ZoteroError } from '../../base/errors.js';
import { readableFile, within } from '../../base/files.js';
import { snapshot } from './snapshot.js';

export class DatabaseAdapter implements Adapter {
  source: Source;
  private constructor(private readonly db: DatabaseSync, private readonly folder: string,
    private readonly directory: string, private readonly linkedRoots: string[], identity: string) {
    this.source = { backend: 'database', identity, observedAt: new Date().toISOString() };
  }
  static async connect(directory: string, linkedRoots: string[], signal: AbortSignal) {
    const root = await realpath(directory);
    const copy = await snapshot(root, signal);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(copy.file, { enableForeignKeyConstraints: false });
      db.exec('PRAGMA trusted_schema=OFF');
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new ZoteroError('invalid_snapshot', '文库副本校验失败。');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA query_only=ON');
      // 结构不认识时停止，避免把结构变化误报成空文库。
      for (const table of ['items', 'itemTypes', 'itemData', 'itemDataValues', 'fieldsCombined', 'deletedItems', 'itemAttachments', 'itemNotes']) {
        if (!db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)) {
          throw new ZoteroError('unsupported_schema', 'Zotero 数据库结构尚未支持。');
        }
      }
      return new DatabaseAdapter(db, copy.folder, root, await Promise.all(linkedRoots.map(p => realpath(p))), copy.identity);
    } catch (error) {
      db?.close();
      await rm(copy.folder, { recursive: true, force: true });
      throw error;
    }
  }
  private libraryId(library: LibraryId): number {
    let row;
    if (library === 'user:0') row = this.db.prepare("SELECT libraryID FROM libraries WHERE type='user'").get();
    else row = this.db.prepare('SELECT libraryID FROM groups WHERE groupID=?').get(Number(library.split(':')[1]));
    if (!row) throw new ZoteroError('library_missing', '找不到所选 Zotero 文库。');
    return Number(row.libraryID);
  }
  private itemId(ref: ItemRef): number {
    const row = this.db.prepare('SELECT itemID FROM items WHERE libraryID=? AND key=? AND itemID NOT IN (SELECT itemID FROM deletedItems)')
      .get(this.libraryId(ref.library), ref.key);
    if (!row) throw new ZoteroError('item_missing', '找不到所选条目或附件。');
    return Number(row.itemID);
  }
  async collections(library: LibraryId, signal: AbortSignal): Promise<Collection[]> {
    signal.throwIfAborted();
    const hasTrash = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='deletedCollections'").get();
    return this.db.prepare(`SELECT c.key,c.collectionName,p.key parentKey FROM collections c
      LEFT JOIN collections p ON p.collectionID=c.parentCollectionID
      WHERE c.libraryID=? ${hasTrash ? 'AND c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)' : ''}
      ORDER BY c.collectionName,c.key`).all(this.libraryId(library)).map(row => ({
      key: String(row.key), name: String(row.collectionName), parentKey: row.parentKey ? String(row.parentKey) : null,
    }));
  }
  async item(ref: ItemRef, signal: AbortSignal) {
    signal.throwIfAborted();
    const id = this.itemId(ref);
    const base = this.db.prepare('SELECT t.typeName FROM items i JOIN itemTypes t ON t.itemTypeID=i.itemTypeID WHERE i.itemID=?').get(id)!;
    const fields = Object.fromEntries(this.db.prepare(
      'SELECT f.fieldName,v.value FROM itemData d JOIN fieldsCombined f ON f.fieldID=d.fieldID JOIN itemDataValues v ON v.valueID=d.valueID WHERE d.itemID=?')
      .all(id).map(row => [String(row.fieldName), String(row.value)]));
    const creators = this.db.prepare(
      'SELECT c.firstName,c.lastName,c.fieldMode,t.creatorType FROM itemCreators ic JOIN creators c ON c.creatorID=ic.creatorID JOIN creatorTypes t ON t.creatorTypeID=ic.creatorTypeID WHERE ic.itemID=? ORDER BY ic.orderIndex')
      .all(id).map(row => ({ firstName: row.fieldMode === 1 ? '' : String(row.firstName ?? ''),
        lastName: row.fieldMode === 1 ? '' : String(row.lastName ?? ''),
        name: row.fieldMode === 1 ? String(row.lastName ?? '') : '', creatorType: String(row.creatorType) }));
    const tags = this.db.prepare('SELECT t.name FROM tags t JOIN itemTags it ON it.tagID=t.tagID WHERE it.itemID=? ORDER BY t.name')
      .all(id).map(row => ({ tag: String(row.name) }));
    const collections = this.db.prepare('SELECT c.key FROM collections c JOIN collectionItems ci ON ci.collectionID=c.collectionID WHERE ci.itemID=? AND c.libraryID=? ORDER BY c.key')
      .all(id, this.libraryId(ref.library)).map(row => String(row.key));
    let parentKey: string | undefined;
    if (base.typeName === 'attachment' || base.typeName === 'note') {
      const table = base.typeName === 'attachment' ? 'itemAttachments' : 'itemNotes';
      const row = this.db.prepare('SELECT p.key FROM ' + table + ' c JOIN items p ON p.itemID=c.parentItemID WHERE c.itemID=?').get(id);
      if (row) parentKey = String(row.key);
    }
    return normalizeItem({ ...fields, key: ref.key, itemType: String(base.typeName), creators, tags, collections,
      ...(parentKey ? { parentItem: parentKey } : {}) }, ref.library);
  }
  async *items(library: LibraryId, collection: string | undefined, signal: AbortSignal) {
    const libraryId = this.libraryId(library);
    if (collection && !this.db.prepare('SELECT 1 FROM collections WHERE libraryID=? AND key=?').get(libraryId, collection)) {
      throw new ZoteroError('collection_missing', '找不到所选文库的集合。');
    }
    const sql = `SELECT i.key FROM items i JOIN itemTypes t ON t.itemTypeID=i.itemTypeID
      WHERE i.libraryID=? AND t.typeName NOT IN ('attachment','note','annotation')
      AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
      ${collection ? 'AND i.itemID IN (SELECT ci.itemID FROM collectionItems ci JOIN collections c ON c.collectionID=ci.collectionID WHERE c.libraryID=? AND c.key=?)' : ''}
      ORDER BY i.key`;
    const statement = this.db.prepare(sql);
    const rows = collection ? statement.iterate(libraryId, libraryId, collection) : statement.iterate(libraryId);
    for (const row of rows) {
      signal.throwIfAborted();
      yield await this.item({ library, key: String(row.key) }, signal);
    }
  }
  async attachments(ref: ItemRef, signal: AbortSignal): Promise<Attachment[]> {
    signal.throwIfAborted();
    const item = await this.item(ref, signal);
    const id = this.itemId(ref);
    const sql = `SELECT i.key,a.path,a.linkMode,a.contentType,p.key parentKey FROM itemAttachments a
      JOIN items i ON i.itemID=a.itemID LEFT JOIN items p ON p.itemID=a.parentItemID
      WHERE ${item.type === 'attachment' ? 'a.itemID=?' : 'a.parentItemID=?'}
      AND i.itemID NOT IN (SELECT itemID FROM deletedItems) ORDER BY i.key`;
    const roots = [this.directory, ...this.linkedRoots];
    const output: Attachment[] = [];
    for (const row of this.db.prepare(sql).all(id)) {
      let path: string | null = null;
      const raw = String(row.path ?? '');
      if (raw.startsWith('storage:')) {
        const root = join(this.directory, 'storage', String(row.key));
        const candidate = join(root, raw.slice(8));
        if (!within(root, candidate)) throw new ZoteroError('attachment_outside_root', '附件路径越出 Zotero 存储目录。');
        path = await readableFile(candidate);
        if (path && (!within(this.directory, await realpath(root)) || !within(await realpath(root), path))) throw new ZoteroError('attachment_outside_root', '附件软链接越出存储目录。');
      } else if (Number(row.linkMode) !== 3 && raw) {
        const candidate = raw.startsWith('attachments:')
          ? this.linkedRoots[0] && join(this.linkedRoots[0], raw.slice(12))
          : isAbsolute(raw) ? raw : undefined;
        if (!candidate) throw new ZoteroError('linked_root_required', '请配置 Zotero 链接附件的根目录。');
        path = await readableFile(candidate);
        if (path && !roots.some(root => within(root, path!))) throw new ZoteroError('attachment_outside_root', '请授权链接附件所在目录。');
      }
      const modes: Record<number, string> = { 0: 'imported_file', 1: 'imported_url', 2: 'linked_file', 3: 'linked_url' };
      output.push({ ref: { library: ref.library, key: String(row.key) }, parentKey: row.parentKey ? String(row.parentKey) : null,
        title: (await this.item({ library: ref.library, key: String(row.key) }, signal)).title,
        mimeType: String(row.contentType ?? ''), linkMode: modes[Number(row.linkMode)] ?? 'unknown',
        path, available: path !== null });
    }
    return output;
  }
  async notes(ref: ItemRef, signal: AbortSignal): Promise<Note[]> {
    const item = await this.item(ref, signal);
    if (['note', 'attachment', 'annotation'].includes(item.type)) throw new ZoteroError('parent_required', '请提供母文献条目。');
    return this.db.prepare(`SELECT i.key,n.note FROM itemNotes n JOIN items i ON i.itemID=n.itemID
      WHERE n.parentItemID=? AND i.itemID NOT IN (SELECT itemID FROM deletedItems) ORDER BY i.key`)
      .all(this.itemId(ref)).map(row => ({
        ref: { library: ref.library, key: String(row.key) }, parentKey: ref.key, format: 'html', content: String(row.note),
      }));
  }
  async close() {
    this.db.close();
    await rm(this.folder, { recursive: true, force: true });
  }
}
