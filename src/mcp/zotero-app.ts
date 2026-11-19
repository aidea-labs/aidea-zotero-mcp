/** 右侧 Zotero 应用的单文件资源与受限读取入口。 */
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { keySchema, librarySchema, refSchema } from '../base/validation.js';
import { ZoteroError } from '../base/errors.js';
import type { ZoteroService } from '../base/service.js';

export const zoteroAppUri = 'ui://aidea-zotero/library.html';
const mimeType = 'text/html;profile=mcp-app';
const routeSchema = z.enum(['collections', 'items', 'item', 'attachments', 'notes', 'bibtex']);
const asset = (name: string) => readFile(new URL('../ui/' + name, import.meta.url), 'utf8');

async function appHtml(): Promise<string> {
  const [html, bridge, script] = await Promise.all([asset('prototype.html'), asset('prompt-host.js'), asset('prototype.js')]);
  const code = (bridge.replace('export async function connectPromptHost', 'async function connectPromptHost') + '\n' +
    script.replace("import { connectPromptHost } from './prompt-host.js';", '')).replace(/<\/script/gi, '<\\/script');
  return html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-zotero-app="mcp">')
    .replace('<link rel="stylesheet" href="/vendor/web/pdf_viewer.css">', '')
    .replace('<script type="module" src="/prototype.js"></script>', () => `<script type="module">${code}</script>`);
}

export function registerZoteroApp(server: McpServer, service: ZoteroService) {
  server.registerResource('zotero-library-app', zoteroAppUri, { mimeType, title: 'AIdea Zotero MCP' }, async () => ({
    contents: [{ uri: zoteroAppUri, mimeType, text: await appHtml() }],
  }));
  server.registerTool('zotero-app-read', {
    description: 'Read the current Zotero library from its own app.',
    inputSchema: { route: routeSchema, params: z.record(z.string(), z.string()).optional(), refs: z.array(refSchema).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: zoteroAppUri, visibility: ['app'] } },
  }, async ({ route, params = {}, refs }, { signal }) => {
    const started = Date.now();
    try {
      const library = librarySchema.parse(params.library ?? 'user:0');
      const ref = () => refSchema.parse({ library, key: params.key });
      let result: unknown;
      switch (route) {
        case 'collections': result = await service.collections(library, signal); break;
        case 'items': result = await service.search({ library,
          query: z.string().max(1000).parse(params.query ?? ''),
          offset: z.coerce.number().int().min(0).max(9999).parse(params.offset ?? '0'),
          limit: z.coerce.number().int().min(1).max(100).parse(params.limit ?? '100'),
          collection: keySchema.optional().parse(params.collection),
          author: z.string().max(300).optional().parse(params.author),
          yearFrom: z.coerce.number().int().min(1).max(9999).optional().parse(params.yearFrom),
          yearTo: z.coerce.number().int().min(1).max(9999).optional().parse(params.yearTo),
          tag: z.string().max(300).optional().parse(params.tag),
        }, signal); break;
        case 'item': result = await service.item(ref(), signal); break;
        case 'notes': result = await service.notes(ref(), signal); break;
        case 'attachments': {
          const found = await service.attachments(ref(), signal);
          result = { source: found.source, value: found.value.map(a => ({ ref: a.ref, title: a.title, mimeType: a.mimeType, available: a.available })) };
          break;
        }
        case 'bibtex':
          if (!refs?.length) throw new ZoteroError('invalid_request', '请选择要导出的文献。');
          result = await service.bibtex(refs, signal); break;
      }
      process.stderr.write(JSON.stringify({ scope: 'zotero.app', route, phase: 'completed', elapsedMs: Date.now() - started }) + '\n');
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch {
      process.stderr.write(JSON.stringify({ scope: 'zotero.app', route, phase: 'failed', elapsedMs: Date.now() - started }) + '\n');
      return { isError: true, content: [{ type: 'text' as const, text: 'Zotero 读取失败，请稍后重试。' }] };
    }
  });
}
