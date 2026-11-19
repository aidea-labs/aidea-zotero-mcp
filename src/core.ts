/** 嵌入其他宿主的入口；导入本模块不会启动 stdio 或读取文库。 */
export { ZoteroService } from './base/service.js';
export { AdapterRouter, isZoteroRunning } from './router.js';
export { ApiAdapter } from './adapters/api/index.js';
export { DatabaseAdapter } from './adapters/database/index.js';
export { readConfig } from './config.js';
export { createServer } from './mcp/server.js';
export { ZoteroError } from './base/errors.js';
export type { Config } from './config.js';
export type { Search } from './base/service.js';
export type { Adapter, AdapterAccess, Attachment, Collection, Creator, Item, ItemRef, LibraryId, Note,
  OpenRequest, Reader, Source } from './base/types.js';
