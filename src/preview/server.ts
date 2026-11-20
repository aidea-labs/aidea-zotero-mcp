/** 本地 HTML 原型的只读入口。页面通过这里调用共用服务，不自行访问数据库或任意文件。 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ZoteroService } from '../base/service.js';
import { ZoteroError } from '../base/errors.js';
import { within } from '../base/files.js';
import { librarySchema, keySchema, refSchema } from '../base/validation.js';
import { extractPrompt, extractQuestionSchema, paperIdSchema, summarizePrompt } from '../mcp/prompts.js';

const cookieName = 'aidea_zotero_preview';
const maxRequestBytes = 1024 * 1024;
const builtUiDirectory = fileURLToPath(new URL('../ui/', import.meta.url));
const pdfJsDirectory = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const actionNames = new Map([
  ['/api/collections', 'collections'], ['/api/items', 'search'], ['/api/item', 'item'],
  ['/api/notes', 'notes'], ['/api/attachments', 'attachments'], ['/api/pdf', 'pdf'],
  ['/api/fulltext', 'fulltext'], ['/api/bibtex', 'bibtex'],
  ['/api/prompts/summarize', 'summarize_prompt'], ['/api/prompts/extract', 'extract_prompt'],
]);
const postRoutes = new Set(['/api/bibtex', '/api/prompts/extract']);
const extractRequest = z.object({ paper_id: paperIdSchema, question: extractQuestionSchema });
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };
export interface PreviewLog { scope: 'zotero.preview'; action: string; requestId: string; phase: string; elapsedMs: number; code?: string }
export function createPreviewServer(service: ZoteroService, options: {
  uiDirectory?: string; log?: (entry: PreviewLog) => void; requestTimeoutMs?: number;
} = {}) {
  const token = randomBytes(32).toString('hex');
  const active = new Set<AbortController>();
  const logSink = options.log ?? (entry => { process.stderr.write(JSON.stringify(entry) + '\n'); });
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  server.on('close', () => { for (const job of active) job.abort(); });

  function json(res: ServerResponse, value: unknown, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }
  async function body(req: IncomingMessage) {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
      throw new ZoteroError('invalid_request', '请求需要 JSON 格式。');
    }
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) throw new ZoteroError('invalid_request', '请求内容超过 1 MiB。');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ZoteroError('invalid_request', '请求内容无法解析。'); }
  }
  function authorized(req: IncomingMessage) {
    const value = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return value?.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token))
      && req.headers['x-aidea-preview'] === '1';
  }
  async function staticFile(pathname: string, res: ServerResponse) {
    let file: string;
    let assetRoot: string;
    if (['/', '/prototype.html', '/prototype.js', '/prompt-host.js'].includes(pathname)) {
      assetRoot = options.uiDirectory ?? builtUiDirectory;
      const page = pathname === '/' || pathname === '/prototype.html';
      file = resolve(assetRoot, page ? 'prototype.html' : pathname.slice(1));
      if (page) {
        res.setHeader('Set-Cookie', cookieName + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400');
      }
    } else if (pathname.startsWith('/vendor/')) {
      assetRoot = pdfJsDirectory;
      const path = decodeURIComponent(pathname.slice('/vendor/'.length));
      // 仅发送 PDF.js 自己的静态资源。不能利用 ../ 读库、配置或项目源码。
      if (!/^(build\/(pdf|pdf.worker)\.mjs|web\/pdf_viewer\.css|(cmaps|standard_fonts|wasm)\/[^/]+)$/.test(path)) return false;
      file = resolve(assetRoot, path);
    } else return false;
    const actual = await realpath(file);
    if (!within(await realpath(assetRoot), actual)) throw new ZoteroError('access_denied', '无法访问该文件。');
    res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(actual));
    return true;
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now(), requestId = randomUUID();
    const controller = new AbortController(); active.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.requestTimeoutMs ?? 60000)]);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    let action = 'static';
    function log(phase: string, code?: string) {
      try { logSink({ scope: 'zotero.preview', action, requestId, phase, elapsedMs: Date.now() - started, ...(code ? { code } : {}) }); }
      catch { /* 诊断写入失败不能破坏只读结果。 */ }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new ZoteroError('access_denied', '本地服务尚未就绪。');
      const origin = 'http://127.0.0.1:' + address.port;
      const url = new URL(req.url ?? '/', origin);
      action = actionNames.get(url.pathname) ?? 'static'; log('started');
      if (req.headers.host !== '127.0.0.1:' + address.port || (req.headers.origin && req.headers.origin !== origin)) {
        throw new ZoteroError('access_denied', '请从本地原型页面访问文库。');
      }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && await staticFile(url.pathname, res)) { log('completed'); return; }
        json(res, { error: { code: 'not_found', message: '页面不存在。' } }, 404); return;
      }
      if (!authorized(req) || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new ZoteroError('access_denied', '页面会话已过期，请重新打开原型。');
      }
      if (req.method !== (postRoutes.has(url.pathname) ? 'POST' : 'GET')) {
        throw new ZoteroError('invalid_request', '该操作不支持此请求方式。');
      }
      log('validated');
      const params = url.searchParams;
      const library = librarySchema.parse(params.get('library') ?? 'user:0');
      const ref = () => refSchema.parse({ library, key: params.get('key') });
      let output: unknown;
      switch (url.pathname) {
        case '/api/prompts/summarize': output = summarizePrompt(z.string().parse(params.get('paper_id'))); break;
        case '/api/prompts/extract': {
          const { paper_id, question } = extractRequest.parse(await body(req));
          output = extractPrompt(paper_id, question);
          break;
        }
        case '/api/collections': output = await service.collections(library, signal); break;
        case '/api/items': output = await service.search({ library,
          query: z.string().max(1000).parse(params.get('query') ?? ''),
          ...(params.get('collection') ? { collection: keySchema.parse(params.get('collection')) } : {}),
          limit: z.coerce.number().int().min(1).max(100).parse(params.get('limit') ?? '100'),
          offset: z.coerce.number().int().min(0).max(9999).parse(params.get('offset') ?? '0'),
        }, signal); break;
        case '/api/item': output = await service.item(ref(), signal); break;
        case '/api/notes': output = await service.notes(ref(), signal); break;
        case '/api/attachments': {
          const result = await service.attachments(ref(), signal);
          // 页面只拿附件身份，完整本地路径不需要在浏览器里复制一份。
          output = { source: result.source, value: result.value.map(({ path: _path, ...attachment }) => attachment) }; break;
        }
        case '/api/pdf': {
          const file = await service.file(ref(), signal);
          const content = await service.resource(file.value.uri, signal);
          signal.throwIfAborted();
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.end(Buffer.from(content.value.blob, 'base64')); log('completed'); return;
        }
        case '/api/fulltext': output = await service.fulltext({ refs: [ref()],
          query: z.string().trim().min(1).max(1000).parse(params.get('query')),
          startPage: z.coerce.number().int().min(1).max(10000).parse(params.get('page') ?? '1'),
          maxPages: 30, maxMatches: 10,
        }, signal); break;
        case '/api/bibtex': {
          const input = z.object({ refs: z.array(refSchema).min(1) }).parse(await body(req));
          output = await service.bibtex(input.refs, signal); break;
        }
        default: json(res, { error: { code: 'not_found', message: '操作不存在。' } }, 404); return;
      }
      signal.throwIfAborted(); json(res, output); log('completed');
    } catch (error) {
      const code = signal.aborted ? 'cancelled' : error instanceof ZoteroError ? error.code
        : error instanceof z.ZodError ? 'invalid_request' : 'operation_failed';
      log('failed', code);
      if (!res.headersSent && !res.destroyed) json(res, { error: { code, message: error instanceof ZoteroError ? error.message
        : signal.aborted ? '读取超时或已取消，请重试。' : code === 'invalid_request' ? '请求参数不正确。' : '无法读取文库，请检查 Zotero 的数据目录与权限后重试。' } },
      code === 'access_denied' ? 403 : code === 'invalid_request' ? 400 : 503);
    } finally {
      active.delete(controller); res.off('close', cancel); log('cleanup');
    }
  }
  return { server, abort: () => { for (const job of active) job.abort(); } };
}
