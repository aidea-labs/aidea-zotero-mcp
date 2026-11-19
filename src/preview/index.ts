/** 本地评审启动入口，复用 MCP 的配置、来源选择和只读能力；Ctrl+C 回收请求与监听端口。 */
import { ZoteroService } from '../base/service.js';
import { AdapterRouter } from '../router.js';
import { readConfig } from '../config.js';
import { createPreviewServer } from './server.js';

const port = Number(process.env.ZOTERO_PREVIEW_PORT ?? '54743');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('原型端口需要在 1024–65535 之间。');
const preview = createPreviewServer(new ZoteroService(new AdapterRouter(readConfig())));
preview.server.listen(port, '127.0.0.1', () => process.stderr.write('AIdea Zotero http://127.0.0.1:' + port + '/prototype.html\n'));
preview.server.on('error', () => { process.stderr.write('原型启动失败，请检查端口是否已被占用。\n'); process.exitCode = 1; });
function close() { preview.abort(); preview.server.close(); preview.server.closeIdleConnections(); }
process.once('SIGINT', close); process.once('SIGTERM', close);
