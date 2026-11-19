#!/usr/bin/env node
/** stdio 启动入口，MCP 生命周期与本机进程退出共用清理路径。 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig } from './config.js';
import { AdapterRouter } from './router.js';
import { ZoteroService } from './base/service.js';
import { createServer } from './mcp/server.js';

const server = createServer(new ZoteroService(new AdapterRouter(readConfig())));
let closing: Promise<void> | undefined;
function close() {
  closing ??= server.close();
  void closing.catch(() => { process.exitCode = 1; });
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
process.stdin.once('end', close);
await server.connect(new StdioServerTransport());
