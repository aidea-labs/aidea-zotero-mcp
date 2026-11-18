/** PDF.js 负责本地正文提取，页码是 PDF 文件页序，从 1 开始。 */
import { ZoteroError } from './errors.js';
import { readPdf } from './files.js';
import type { PdfSearchResult } from './types.js';

export async function searchPdf(file: string, query: string, signal: AbortSignal,
  startPage: number, maxPages: number, maxMatches: number): Promise<PdfSearchResult> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: await readPdf(file, signal),
    useSystemFonts: true, disableFontFace: true, useWorkerFetch: false });
  const abort = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const matches: { page: number; text: string }[] = [];
  const noTextPages: number[] = [];
  try {
    const document = await task.promise;
    if (startPage > document.numPages) throw new ZoteroError('page_out_of_range', '起始页超过 PDF 总页数。');
    const end = Math.min(document.numPages, startPage + maxPages - 1);
    const terms = query.toLocaleLowerCase().trim().split(/\s+/);
    let scannedThrough = startPage - 1;
    for (let number = startPage; number <= end; number++) {
      signal.throwIfAborted();
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      page.cleanup();
      scannedThrough = number;
      if (!text.trim()) noTextPages.push(number);
      const lower = text.toLocaleLowerCase();
      if (terms.every(term => lower.includes(term))) {
        const position = lower.indexOf(terms[0]!);
        matches.push({ page: number, text: text.slice(Math.max(0, position - 250), position + 950).trim() });
        if (matches.length >= maxMatches) break;
      }
    }
    return { matches, totalPages: document.numPages, startPage, scannedThrough,
      nextPage: scannedThrough < document.numPages ? scannedThrough + 1 : null,
      noTextPages, pageNumbering: 'pdf-1-based',
      notice: noTextPages.length ? '部分页没有文本层，未进行 OCR。' : null };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ZoteroError) throw error;
    throw new ZoteroError('pdf_unreadable', 'PDF 解析失败，可能已加密、损坏或格式不支持。');
  } finally {
    signal.removeEventListener('abort', abort);
    await task.destroy();
  }
}
