/** HTML 原型使用真实服务。每次搜索/选文献有独立请求身份，迟到结果不能覆盖后来的操作。 */

const $ = id => document.getElementById(id);
const library = 'user:0';
let items = [], selected = null, collections = [], folder = '', offset = 0, nextOffset = null;
let detailMode = 'info', parts = {}, listVersion = 0, detailVersion = 0, readerVersion = 0;
let listAbort, detailAbort, searchVersion = 0, findTimer, statusTimer, currentReader;
let pdfModule, modalVersion = 0;
let readerLayout, requestedReaderWidth, resizeTimer, readerScrollFrame;
const checked = new Map(), opened = new Map();
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function btn(text, action, className) {
  const node = el('button', text, className); node.type = 'button';
  node.addEventListener('click', () => { Promise.resolve().then(action).catch(report); });
  return node;
}
const identity = ref => ref.library + '/' + ref.key;
const author = p => p.creators.map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).join(' · ');
const year = p => /\b\d{4}\b/.exec(p.fields.date || '')?.[0] || '';
const cite = p => p.fields.citationKey || /^Citation Key:\s*(.+)$/mi.exec(p.fields.extra || '')?.[1]?.trim()
  || 'zotero_' + p.ref.library.replace(':', '_') + '_' + p.ref.key;
function notify(text) { clearTimeout(statusTimer); $('status').textContent = text; $('status').hidden = false; statusTimer = setTimeout(() => { $('status').hidden = true; }, 6000); }
function report(error) { if (error.name !== 'AbortError') notify(error.message || '操作未完成，请重试。'); }
function params(ref = {}) { return new URLSearchParams({ library, ...ref }); }
async function request(route, { query, signal, refs, binary = false } = {}) {
  const response = await fetch('/api/' + route + (query ? '?' + query : ''), {
    method: refs ? 'POST' : 'GET', credentials: 'same-origin', signal,
    headers: { 'X-Aidea-Preview': '1', ...(refs ? { 'Content-Type': 'application/json' } : {}) },
    ...(refs ? { body: JSON.stringify({ refs }) } : {}),
  });
  if (!response.ok) { const body = await response.json(); throw new Error(body.error?.message || '读取失败，请重试。'); }
  return binary ? response.arrayBuffer() : response.json();
}
async function loadCollections() {
  try { collections = (await request('collections', { query: params() })).value; }
  catch { /* 集合名称不影响文献查询，失败时不猜测集合名称。 */ }
}
function showResults() {
  $('search-home').hidden = true; $('app-main').hidden = false; $('work-tabs').hidden = false;
  activate('library');
}
async function submitSearch() {
  offset = 0; detailAbort?.abort(); detailVersion++; selected = null; parts = {};
  $('detail').hidden = true; $('library-view').classList.remove('has-detail'); setDetailOpen(false);
  showResults(); await loadItems();
}
async function loadItems() {
  const version = ++listVersion; listAbort?.abort(); listAbort = new AbortController();
  $('counter').textContent = ''; $('rows').replaceChildren(); $('empty').hidden = true;
  $('selection-controls').hidden = true;
  $('previous-results').disabled = true; $('next-results').disabled = true;
  $('pagination').hidden = true;
  $('result-page').textContent = ''; $('rows').setAttribute('aria-busy', 'true');
  try {
    const result = await request('items', { query: params({ query: $('query').value, ...(folder ? { collection: folder } : {}), offset: String(offset) }), signal: listAbort.signal });
    if (version !== listVersion) return;
    items = result.value.items; nextOffset = result.value.nextOffset;
    renderRows(); updateCounter(result.value.matched);
    $('rows').parentElement.scrollTop = 0;
    $('previous-results').disabled = offset === 0; $('next-results').disabled = nextOffset === null;
    $('pagination').hidden = offset === 0 && nextOffset === null;
    $('result-page').textContent = items.length ? (offset + 1) + '–' + (offset + items.length) : '';
    if (!selected || !items.some(p => identity(p.ref) === identity(selected.ref))) {
      detailAbort?.abort(); detailVersion++; selected = null; $('detail').replaceChildren(); $('detail').hidden = true;
      $('library-view').classList.remove('has-detail'); setDetailOpen(false);
    }
    if (result.value.notice) notify(result.value.notice);
  } catch (error) {
    if (version !== listVersion || error.name === 'AbortError') return;
    $('counter').textContent = '文献读取失败';
    $('empty').hidden = false; $('empty').replaceChildren(el('p', error.message), btn('重试', loadItems));
  } finally { if (version === listVersion) $('rows').setAttribute('aria-busy', 'false'); }
}
let matched = 0;
function updateCounter(count = matched) {
  matched = count;
  $('counter').textContent = checked.size ? '已选 ' + checked.size + ' 篇 · ' + matched + ' 篇文献' : matched + ' 篇文献';
  $('batch').disabled = !checked.size; $('selection-controls').hidden = !items.length;
}
function renderRows() {
  $('rows').replaceChildren(); $('empty').hidden = !!items.length;
  if (!items.length) $('empty').replaceChildren(el('p', '没有匹配的文献，试试其他关键词。'));
  $('select-all').checked = !!items.length && items.every(p => checked.has(identity(p.ref)));
  $('select-all').indeterminate = items.some(p => checked.has(identity(p.ref))) && !$('select-all').checked;
  for (const paper of items) {
    const row = el('article', undefined, selected && identity(paper.ref) === identity(selected.ref) ? 'result selected' : 'result');
    row.setAttribute('role','listitem');
    const check = el('input'); check.type = 'checkbox'; check.checked = checked.has(identity(paper.ref)); check.setAttribute('aria-label', '选择 ' + paper.title);
    check.addEventListener('change', () => { selectForExport(paper, check.checked); renderRows(); updateCounter(); });
    const checkCell = el('div', undefined, 'result-check'); checkCell.append(check);
    const content = el('div', undefined, 'result-content');
    content.append(btn(paper.title || '无题名', () => selectPaper(paper), 'paper-title'));
    const metadata = [author(paper), paper.fields.publicationTitle || paper.fields.publisher, year(paper)].filter(Boolean);
    if (metadata.length) content.append(el('div', metadata.join(' · '), 'result-meta'));
    if(paper.fields.abstractNote) content.append(el('p',paper.fields.abstractNote,'snippet'));
    const actions = el('div', undefined, 'result-actions');
    const citePaper = btn('引用', () => showBib([paper]), 'result-action');
    citePaper.setAttribute('aria-label', '引用 ' + (paper.title || '无题名'));
    actions.append(citePaper);
    content.append(actions);
    content.addEventListener('dblclick', event => {
      if (!event.target.closest('.result-actions')) selectPaper(paper).then(() => openSelected()).catch(report);
    });
    row.append(checkCell, content); $('rows').append(row);
  }
}
function selectForExport(paper, value) {
  const key = identity(paper.ref);
  if (!value) checked.delete(key);
  else checked.set(key, paper);
}
async function selectPaper(paper) {
  modalVersion++;
  const version = ++detailVersion; detailAbort?.abort(); detailAbort = new AbortController();
  const signal = detailAbort.signal;
  selected = paper; detailMode = 'info'; parts = {}; $('detail').hidden = false;
  $('library-view').classList.add('has-detail'); setDetailOpen(true); renderRows(); renderDetail();
  // 单项失败留在对应区域，不能把“读取失败”显示成“没有笔记/附件”。
  await Promise.all(['item', 'notes', 'attachments'].map(async route => {
    try {
      const result = await request(route, { query: params(paper.ref), signal });
      if (version !== detailVersion) return;
      if (route === 'item') { selected = result.value; }
      else parts[route] = result.value;
    } catch (error) {
      if (version !== detailVersion || error.name === 'AbortError') return;
      parts[route + 'Error'] = error.message;
    }
    if (version === detailVersion) renderDetail();
  }));
}
function addError(root, message) { root.append(el('p', message, 'error-message'), btn('重试', () => selectPaper(selected))); }
function noteText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed').forEach(node => node.remove());
  doc.querySelectorAll('p,div,li,h1,h2,h3,h4,blockquote,tr').forEach(node => node.append(doc.createTextNode('\n')));
  doc.querySelectorAll('br').forEach(node => node.replaceWith(doc.createTextNode('\n')));
  return doc.body.textContent.trim();
}
function renderDetail() {
  const p = selected, root = $('detail'); if (!p) { root.replaceChildren(); return; }
  const heading = el('div', undefined, 'detail-heading');
  const close = btn('×', () => { setDetailOpen(false); $('detail-toggle').focus(); }, 'tab-close detail-dismiss');
  close.setAttribute('aria-label', '收起详情');
  close.title = '收起详情';
  heading.append(el('h1', p.title || '无题名'), close);
  root.replaceChildren(heading, el('p', [author(p), year(p)].filter(Boolean).join(' · '), 'meta'));
  const actions = el('div', undefined, 'action-stack');
  const open = btn('打开 PDF', openSelected, 'primary');
  open.disabled = !parts.attachments?.some(a => a.mimeType === 'application/pdf' && a.available);
  actions.append(open);
  actions.append(btn('导出 BibTeX', () => showBib([p]))); root.append(actions);
  if (parts.attachmentsError) addError(root, parts.attachmentsError);
  const tabs = el('div', undefined, 'detail-tabs');
  for (const [mode, label] of [['info', '条目信息'], ['notes', '已有笔记'], ['files', '附件']]) {
    const button = btn(label, () => { detailMode = mode; renderDetail(); }); button.setAttribute('aria-pressed', detailMode === mode); tabs.append(button);
  }
  root.append(tabs);
  if (parts.itemError) addError(root, parts.itemError);
  if (detailMode === 'notes') {
    if (parts.notesError) addError(root, parts.notesError);
    else if (parts.notes) {
      if (!parts.notes.notes.length) root.append(el('p', '这篇文献没有子笔记。', 'note-empty'));
      for (const note of parts.notes.notes) root.append(el('div', noteText(note.content), 'note-card note-text'));
    }
  } else if (detailMode === 'files') {
    if (parts.attachments) {
      if (!parts.attachments.length) root.append(el('p', '这篇文献没有附件。', 'note-empty'));
      for (const a of parts.attachments) {
        const card = el('div', undefined, 'note-card'); card.append(el('h2', a.title || '附件', 'attachment-name'));
        card.append(el('p', a.available ? (a.mimeType === 'application/pdf' ? '本地 PDF' : a.mimeType || '本地附件') : '本机无可读取文件', 'meta'));
        if (a.available && a.mimeType === 'application/pdf') card.append(btn('打开阅读', () => openPaper(p, a)));
        root.append(card);
      }
    }
  } else {
    if (p.fields.abstractNote) root.append(el('h2', '摘要'), el('p', p.fields.abstractNote, 'abstract'));
    const values = [['作者', author(p)], ['年份', year(p)], ['期刊', p.fields.publicationTitle], ['DOI', p.fields.DOI],
      ['引用键', cite(p)], ['集合', p.collections.map(key => collections.find(c => c.key === key)?.name).filter(Boolean).join('、')]];
    const dl = el('dl'); values.filter(([, value]) => value).forEach(([label, value]) => dl.append(el('dt', label), el('dd', value))); root.append(dl);
    if (p.tags.length) { root.append(el('h2', '标签')); const tags = el('div', undefined, 'tags'); p.tags.forEach(tag => tags.append(el('span', tag, 'tag'))); root.append(tags); }
  }
}
async function openSelected() {
  const paper = selected;
  if (parts.attachmentsError) throw new Error(parts.attachmentsError);
  if (!parts.attachments) throw new Error('附件尚未读取完成，请稍后重试。');
  const choices = parts.attachments.filter(a => a.mimeType === 'application/pdf' && a.available);
  if (!choices.length) throw new Error('这篇文献没有本机可读取的 PDF。');
  if (choices.length === 1) return openPaper(paper, choices[0]);
  dialog('选择 PDF', choices.map(a => btn(a.title || 'PDF 附件', () => { $('modal').close(); return openPaper(paper, a); })), [btn('取消', () => $('modal').close())]);
}
function activate(tab) {
  if (tab === 'library') {
    if (currentReader && matchMedia('(max-width:760px)').matches) setDetailOpen(false);
    stopPendingFind(); releaseReaderLayout();
    currentReader = null;
  }
  $('library-view').hidden = tab !== 'library'; $('reader-view').hidden = tab === 'library';
  $('library-tab').setAttribute('aria-selected', tab === 'library');
  for (const [id, entry] of opened) entry.button.setAttribute('aria-selected', id === tab);
}
function setDetailOpen(open) {
  $('library-view').classList.toggle('show-detail', open);
  $('detail').hidden = !open;
  $('detail-resizer').hidden = !open;
  $('detail-toggle').setAttribute('aria-expanded', open);
  if (open) updateDetailResizeRange();
}
function detailResizeRange() {
  const narrow = matchMedia('(max-width:760px)').matches;
  const max = Math.max(0, Math.min(narrow ? 520 : 620, $('library-view').clientWidth - (narrow ? 32 : 300)));
  return { min: Math.min(240, max), max };
}
function updateDetailResizeRange() {
  const handle = $('detail-resizer');
  if (handle.hidden || $('library-view').hidden) return;
  const { min, max } = detailResizeRange();
  handle.setAttribute('aria-valuemin', min);
  handle.setAttribute('aria-valuemax', max);
  handle.setAttribute('aria-valuenow', Math.round($('detail').getBoundingClientRect().width));
}
function resizeDetail(width) {
  const { min, max } = detailResizeRange();
  $('library-view').style.setProperty('--detail-width', Math.round(Math.max(min, Math.min(max, width))) + 'px');
  updateDetailResizeRange();
}
function removeReader(id) {
  const entry = opened.get(id);
  if (!entry) return;
  opened.delete(id);
  entry.tab.remove();
  void entry.task?.destroy().catch(() => {});
}
async function closeReader(id) {
  const ids = [...opened.keys()];
  const index = ids.indexOf(id);
  if (index < 0) return;
  const entry = opened.get(id);
  if (currentReader !== entry) {
    const hadFocus = entry.tab.contains(document.activeElement);
    removeReader(id);
    if (hadFocus) (currentReader?.button ?? $('library-tab')).focus();
    return;
  }
  const neighbor = opened.get(ids[index + 1] ?? ids[index - 1]);
  activate('library');
  removeReader(id);
  if (!neighbor) { $('library-tab').focus(); return; }
  neighbor.button.focus();
  await openPaper(neighbor.paper, neighbor.attachment);
}
async function openPaper(paper, attachment, page) {
  const id = identity(attachment.ref);
  let entry = opened.get(id);
  if (!entry) {
    const title = paper.title || attachment.title || '无题名';
    const tab = el('div', undefined, 'tab-item'); tab.setAttribute('role', 'presentation');
    const button = btn(title, () => openPaper(entry.paper, entry.attachment), 'tab');
    button.id = 'reader-tab-' + attachment.ref.key; button.title = title;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'reader-view');
    const close = btn('×', () => closeReader(id), 'tab-close');
    close.setAttribute('aria-label', '关闭 ' + title); close.title = '关闭标签';
    button.addEventListener('keydown', event => {
      if (event.key === 'Delete') { event.preventDefault(); void closeReader(id).catch(report); }
    });
    tab.append(button, close);
    entry = { paper, attachment, tab, button, page: 1, document: null, zoom: 'fit',
      matches: [], matchIndex: -1, searchQuery: '', findState: 'idle' };
    opened.set(id, entry); $('work-tabs').append(tab);
  }
  if (opened.size > 6) {
    const oldId = [...opened.keys()].find(key => key !== id && opened.get(key) !== currentReader);
    if (oldId) removeReader(oldId);
  }
  if (currentReader !== entry) { stopPendingFind(); releaseReaderLayout(); }
  currentReader = entry;
  if (page) { entry.page = page; entry.position = undefined; }
  $('fulltext').value = entry.searchQuery; $('reader-view').setAttribute('aria-labelledby', entry.button.id);
  activate(id);
  entry.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncPdfToolbar(entry);
  await renderReader();
  if (page && readerLayout?.entry === entry) goToPdfPage(page);
  if (currentReader === entry && entry.document && entry.searchQuery && entry.findState === 'idle') queueFind(entry, 0);
}
async function getPdfModule() {
  if (!pdfModule) { pdfModule = await import('/vendor/build/pdf.mjs'); pdfModule.GlobalWorkerOptions.workerSrc = '/vendor/build/pdf.worker.mjs'; }
  return pdfModule;
}
function readerContentWidth() {
  const pane = $('sheet-pane');
  const style = getComputedStyle(pane);
  return Math.max(1, Math.floor(pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
}
const pdfCssScale = 96 / 72;
const zoomSteps = [50, 75, 90, 100, 125, 150, 175, 200, 250, 300];
function zoomStep(entry, direction) {
  const current = entry.zoom === 'fit' ? entry.fitPercent ?? 100 : Number(entry.zoom);
  return direction < 0 ? zoomSteps.findLast(value => value < current) : zoomSteps.find(value => value > current);
}
function syncPdfToolbar(entry) {
  const select = $('zoom-level');
  select.value = entry.zoom;
  select.options[0].textContent = entry.fitPercent ? `适合宽度 (${entry.fitPercent}%)` : '适合宽度';
  select.disabled = !entry.document;
  $('zoom-out').disabled = !entry.document || zoomStep(entry, -1) === undefined;
  $('zoom-in').disabled = !entry.document || zoomStep(entry, 1) === undefined;
  $('fulltext').disabled = !entry.document;
  syncFindControls(entry);
}
function changeZoom(value) {
  if (!currentReader || currentReader.zoom === value) return;
  currentReader.zoom = value;
  syncPdfToolbar(currentReader);
  void renderReader();
}
function cancelPageJob(layout) {
  layout.job?.render?.cancel();
  layout.job?.text?.cancel();
  layout.job = undefined;
}
function releaseReaderLayout() {
  readerVersion++;
  clearTimeout(resizeTimer);
  cancelAnimationFrame(readerScrollFrame);
  readerScrollFrame = undefined;
  if (readerLayout) {
    readerLayout.entry.position = captureReaderPosition(readerLayout);
    cancelPageJob(readerLayout);
    readerLayout = undefined;
  }
  clearPdfHighlights();
  $('sheet').replaceChildren();
}
function pageTop(layout, slot) { return layout.stack.offsetTop + slot.node.offsetTop; }
function pageAt(layout, y) {
  let low = 0, high = layout.pages.length;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (pageTop(layout, layout.pages[middle]) <= y) low = middle;
    else high = middle;
  }
  return low;
}
function captureReaderPosition(layout) {
  const pane = $('sheet-pane');
  const slot = layout.pages[pageAt(layout, pane.scrollTop)];
  return { page: slot.number, fraction: (pane.scrollTop - pageTop(layout, slot)) / slot.height, left: pane.scrollLeft };
}
function restoreReaderPosition(layout, position) {
  const pane = $('sheet-pane');
  const slot = layout.pages[position.page - 1];
  pane.scrollTop = pageTop(layout, slot) + position.fraction * slot.height;
  pane.scrollLeft = position.left;
}
function layoutPdfSlot(layout, slot) {
  const size = layout.entry.dimensions.get(slot.number) ?? layout.entry.firstPageSize;
  const kind = layout.entry.zoom;
  const scale = kind === 'fit' ? layout.width / size.width : Number(kind) / 100 * pdfCssScale;
  slot.width = size.width * scale;
  slot.height = size.height * scale;
  slot.node.style.width = slot.width + 'px';
  slot.node.style.height = slot.height + 'px';
  slot.scale = scale;
  // 缩放时先保留旧图，直到该页在新倍率绘制完成。
  if (slot.frame) slot.frame.style.transform = `scale(${scale / slot.drawnScale})`;
}
function syncPageStatus(layout, number) {
  const entry = layout.entry;
  entry.page = number;
  $('page-status').textContent = number + ' / ' + layout.pages.length;
  $('prev').disabled = number === 1;
  $('next').disabled = number === layout.pages.length;
  const size = entry.dimensions.get(number) ?? entry.firstPageSize;
  const fit = Math.round(layout.width / size.width / pdfCssScale * 100);
  if (fit !== entry.fitPercent) { entry.fitPercent = fit; syncPdfToolbar(entry); }
}
function updateReaderViewport(layout = readerLayout) {
  if (!layout || layout !== readerLayout || $('reader-view').hidden) return;
  const pane = $('sheet-pane'), top = pane.scrollTop;
  const first = pageAt(layout, top);
  const last = pageAt(layout, top + pane.clientHeight);
  const atBottom = top > 0 && top + pane.clientHeight >= pane.scrollHeight - 1;
  const current = atBottom ? layout.pages.length - 1 : pageAt(layout, top + Math.min(90, pane.clientHeight / 4));
  syncPageStatus(layout, current + 1);
  // 只保留视口和前后各一页的画布。占位保留尺寸，因此长文档依旧能直接滚动到任意页。
  const start = Math.max(0, first - 1), end = Math.min(layout.pages.length - 1, last + 1);
  let evicted = false;
  for (const slot of layout.resident) {
    if (slot.number - 1 >= start && slot.number - 1 <= end) continue;
    slot.node.replaceChildren();
    slot.frame = slot.fragments = slot.drawnScale = undefined;
    layout.resident.delete(slot);
    evicted = true;
  }
  if (evicted) paintPdfMatches(layout.entry);
  if (layout.job && (layout.job.slot.number - 1 < start || layout.job.slot.number - 1 > end)) cancelPageJob(layout);
  if (layout.job) return;
  const candidates = layout.pages.slice(first, last + 1);
  if (first > 0) candidates.push(layout.pages[first - 1]);
  if (last < end) candidates.push(layout.pages[last + 1]);
  const slot = candidates.find(page => page.drawnScale !== page.scale && !page.error);
  if (slot) void drawPdfPage(layout, slot);
}
async function drawPdfPage(layout, slot) {
  const job = { slot };
  layout.job = job;
  const current = () => readerLayout === layout && layout.job === job;
  try {
    const entry = layout.entry, page = await entry.document.getPage(slot.number);
    if (!current()) return;
    if (!entry.dimensions.has(slot.number)) {
      const size = page.getViewport({ scale: 1 });
      const anchor = captureReaderPosition(layout);
      entry.dimensions.set(slot.number, { width: size.width, height: size.height });
      layoutPdfSlot(layout, slot);
      restoreReaderPosition(layout, anchor);
    }
    const scale = slot.scale, viewport = page.getViewport({ scale });
    const frame = el('div', undefined, 'pdf-frame');
    frame.style.width = viewport.width + 'px';
    frame.style.height = viewport.height + 'px';
    frame.style.setProperty('--scale-factor', String(viewport.scale));
    const canvas = el('canvas');
    canvas.setAttribute('aria-label', 'PDF 第 ' + slot.number + ' 页');
    const dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(8e6 / (viewport.width * viewport.height)), 4096 / Math.max(viewport.width, viewport.height));
    canvas.width = Math.max(1, Math.round(viewport.width * dpr));
    canvas.height = Math.max(1, Math.round(viewport.height * dpr));
    const text = el('div', undefined, 'textLayer');
    frame.append(canvas, text);
    job.render = page.render({ canvas, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
    await job.render.promise;
    if (!current()) return;
    const content = await page.getTextContent();
    if (!current()) return;
    job.text = new pdfModule.TextLayer({ textContentSource: content, container: text, viewport });
    await job.text.render();
    if (!current()) return;
    slot.node.replaceChildren(frame);
    slot.frame = frame;
    slot.drawnScale = scale;
    slot.fragments = pdfPageText(content, job.text.textDivs).fragments;
    layout.resident.add(slot);
    paintPdfMatches(entry);
  } catch (error) {
    if (!current() || error.name === 'RenderingCancelledException') return;
    slot.error = true;
    if (!slot.frame) {
      const retry = btn('重试第 ' + slot.number + ' 页', () => { slot.error = false; updateReaderViewport(layout); });
      slot.node.replaceChildren(retry);
    } else notify('这一页暂时无法重新绘制。');
  } finally {
    if (current()) { layout.job = undefined; updateReaderViewport(layout); }
  }
}
function goToPdfPage(number, match = null) {
  const layout = readerLayout;
  if (!layout) return;
  layout.entry.jumpToMatch = match;
  const slot = layout.pages[Math.max(0, Math.min(layout.pages.length - 1, number - 1))];
  $('sheet-pane').scrollTop = slot.number === 1 ? 0 : pageTop(layout, slot);
  updateReaderViewport(layout);
}
async function renderReader() {
  if (!currentReader || $('reader-view').hidden) return;
  clearTimeout(resizeTimer);
  const entry = currentReader, version = ++readerVersion;
  const width = readerContentWidth(), stack = $('sheet');
  requestedReaderWidth = width;
  if (readerLayout?.entry === entry) {
    const layout = readerLayout, anchor = captureReaderPosition(layout);
    cancelPageJob(layout);
    layout.width = width;
    for (const slot of layout.pages) { slot.error = false; layoutPdfSlot(layout, slot); }
    restoreReaderPosition(layout, anchor);
    updateReaderViewport(layout);
    return;
  }
  $('page-status').textContent = '';
  $('prev').disabled = $('next').disabled = true;
  try {
    const pdf = await getPdfModule();
    if (version !== readerVersion) return;
    if (!entry.task) entry.task = pdf.getDocument({ url: '/api/pdf?' + params(entry.attachment.ref), httpHeaders: { 'X-Aidea-Preview': '1' },
      withCredentials: true, disableRange: true, disableStream: true, isEvalSupported: false,
      cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/', wasmUrl: '/vendor/wasm/' });
    entry.document = await entry.task.promise;
    if (version !== readerVersion) return;
    if (!entry.firstPageSize) {
      const first = await entry.document.getPage(1);
      if (version !== readerVersion) return;
      const size = first.getViewport({ scale: 1 });
      entry.firstPageSize = { width: size.width, height: size.height };
      entry.dimensions = new Map([[1, entry.firstPageSize]]);
    }
    const layout = { entry, stack, width, pages: [], resident: new Set() };
    const content = document.createDocumentFragment();
    for (let number = 1; number <= entry.document.numPages; number++) {
      const node = el('div', undefined, 'pdf-page');
      const slot = { number, node };
      layout.pages.push(slot);
      layoutPdfSlot(layout, slot);
      content.append(node);
    }
    stack.replaceChildren(content);
    readerLayout = layout;
    if (entry.position) restoreReaderPosition(layout, entry.position);
    else goToPdfPage(entry.page);
    syncPdfToolbar(entry);
    updateReaderViewport(layout);
  } catch (error) {
    if (version !== readerVersion) return;
    void entry.task?.destroy().catch(() => {});
    entry.task = entry.document = undefined;
    syncPdfToolbar(entry);
    stack.replaceChildren(el('p', error.message || 'PDF 读取失败。', 'pdf-error'), btn('重试', renderReader));
  }
}
// 扫描和高亮使用同一套 PDF 文字偏移，命中可以跨同一页的多个文字片段。
function pdfPageText(content, divs) {
  let text = '', index = 0;
  const fragments = [];
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    const node = divs?.[index]?.firstChild;
    index++;
    if (node?.nodeType === Node.TEXT_NODE && node.data.length === item.str.length && node.data.length) {
      fragments.push({ start: text.length, end: text.length + item.str.length, node });
    }
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return { text, fragments };
}
function clearPdfHighlights() {
  CSS.highlights?.delete('pdf-find');
  CSS.highlights?.delete('pdf-find-active');
}
function highlightRange(fragments, match) {
  const first = fragments.find(part => part.end > match.start);
  const last = fragments.findLast(part => part.start < match.end);
  if (!first || !last || first.start >= match.end || last.end <= match.start) return;
  const range = document.createRange();
  range.setStart(first.node, Math.max(0, match.start - first.start));
  range.setEnd(last.node, Math.min(last.node.length, match.end - last.start));
  return range;
}
function paintPdfMatches(entry) {
  clearPdfHighlights();
  if (readerLayout?.entry !== entry) return;
  const active = entry.matches[entry.matchIndex];
  const normal = CSS.highlights ? new Highlight() : null;
  for (const match of entry.matches) {
    const fragments = readerLayout.pages[match.page - 1]?.fragments;
    if (!fragments) continue;
    const range = highlightRange(fragments, match);
    if (!range) continue;
    if (match !== active) { normal?.add(range); continue; }
    if (CSS.highlights) {
      const marked = new Highlight(range);
      marked.priority = 1;
      CSS.highlights.set('pdf-find-active', marked);
    }
    if (entry.jumpToMatch === active) {
      const pane = $('sheet-pane');
      const bounds = pane.getBoundingClientRect(), rect = range.getClientRects()[0];
      if (rect) {
        entry.jumpToMatch = null;
        pane.scrollTop += rect.top - bounds.top - pane.clientHeight * .28;
        if (rect.left < bounds.left || rect.right > bounds.right) pane.scrollLeft += rect.left - bounds.left - 20;
      }
    }
  }
  if (normal?.size) CSS.highlights.set('pdf-find', normal);
}
function syncFindControls(entry) {
  const count = $('find-count');
  if (!entry.searchQuery || entry.findState === 'idle') count.textContent = '';
  else if (entry.findState === 'searching') count.textContent = '查找中…';
  else if (entry.findState === 'error') count.textContent = '查找失败';
  else if (!entry.hasText) count.textContent = '无文字';
  else count.textContent = `${entry.matchIndex + 1} / ${entry.matches.length}`;
  $('find-previous').disabled = $('find-next').disabled = entry.matches.length === 0;
}
function stopPendingFind() {
  clearTimeout(findTimer);
  searchVersion++;
  if (currentReader?.findState === 'searching') currentReader.findState = 'idle';
}
function setFindQuery() {
  const entry = currentReader;
  if (!entry) return;
  const query = $('fulltext').value.trim();
  if (query === entry.searchQuery) return;
  stopPendingFind();
  entry.searchQuery = query;
  entry.matches = [];
  entry.matchIndex = -1;
  entry.jumpToMatch = null;
  entry.findState = 'idle';
  clearPdfHighlights();
  syncFindControls(entry);
  if (query && entry.document) queueFind(entry);
}
function queueFind(entry, delay = 160) {
  const version = ++searchVersion;
  entry.findState = 'searching';
  syncFindControls(entry);
  findTimer = setTimeout(() => { void scanPdf(entry, version); }, delay);
}
async function scanPdf(entry, version) {
  const escaped = entry.searchQuery.split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('\\s+'), 'giu');
  const matches = [];
  let hasText = false;
  try {
    for (let number = 1; number <= entry.document.numPages; number++) {
      if (version !== searchVersion) return;
      const page = await entry.document.getPage(number);
      if (version !== searchVersion) return;
      const { text } = pdfPageText(await page.getTextContent());
      if (version !== searchVersion) return;
      if (text.trim()) hasText = true;
      for (const hit of text.matchAll(pattern)) matches.push({ page: number, start: hit.index, end: hit.index + hit[0].length });
    }
    entry.hasText = hasText;
    entry.matches = matches;
    entry.findState = 'done';
    if (!matches.length) { syncFindControls(entry); return; }
    const nearby = matches.findIndex(match => match.page >= entry.page);
    entry.matchIndex = (nearby < 0 ? 0 : nearby) - 1;
    await moveFind(1);
  } catch {
    if (version !== searchVersion) return;
    entry.findState = 'error';
    syncFindControls(entry);
  }
}
async function moveFind(direction) {
  const entry = currentReader;
  if (!entry) return;
  if (entry.searchQuery && (entry.findState === 'error' || entry.findState === 'idle') && entry.document) {
    queueFind(entry, 0);
    return;
  }
  if (!entry.matches.length) return;
  entry.matchIndex = (entry.matchIndex + direction + entry.matches.length) % entry.matches.length;
  const active = entry.matches[entry.matchIndex];
  entry.jumpToMatch = active;
  syncFindControls(entry);
  if (active.page !== entry.page) goToPdfPage(active.page, active);
  paintPdfMatches(entry);
}
function dialog(title, body, footer) {
  $('modal-title').textContent = title;
  $('modal-body').replaceChildren(...body);
  $('modal-foot').replaceChildren(...footer);
  if (!$('modal').open) $('modal').showModal();
}
async function showBib(papers) {
  const version = ++modalVersion;
  const result = await request('bibtex', { refs: papers.map(p => p.ref) });
  if(version !== modalVersion) return;
  const { bibtex, count } = result.value;
  dialog('导出 BibTeX', [el('p', count + ' 篇文献'), el('pre', bibtex)], [btn('关闭', () => $('modal').close()), btn('下载 .bib', () => {
    const url = URL.createObjectURL(new Blob([bibtex], { type: 'application/x-bibtex' }));
    const link = el('a'); link.href = url; link.download = 'references.bib'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'primary')]);
}
$('library-tab').addEventListener('click', () => activate('library'));
function bindSearchForm(id, search) {
  const form = $(id);
  form.addEventListener('submit', event => { event.preventDefault(); search(); });
}
bindSearchForm('home-form', () => { $('query').value = $('home-query').value; void submitSearch(); void loadCollections(); });
bindSearchForm('results-form', () => { void submitSearch(); });
$('previous-results').addEventListener('click', () => { offset = Math.max(0, offset - 100); void loadItems(); });
$('next-results').addEventListener('click', () => { if (nextOffset !== null) { offset = nextOffset; void loadItems(); } });
$('select-all').addEventListener('change', event => { items.forEach(p => selectForExport(p, event.target.checked)); renderRows(); updateCounter(); });
$('batch').addEventListener('click', () => { showBib([...checked.values()]).catch(report); });
$('detail-toggle').addEventListener('click', () => {
  setDetailOpen(true);
  $('detail').querySelector('.detail-dismiss')?.focus();
});
const detailResizer = $('detail-resizer');
let detailDrag;
detailResizer.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) return;
  detailDrag = { id: event.pointerId, x: event.clientX, width: $('detail').getBoundingClientRect().width };
  detailResizer.setPointerCapture(event.pointerId);
  $('library-view').classList.add('resizing');
  event.preventDefault();
});
detailResizer.addEventListener('pointermove', event => {
  if (detailDrag?.id === event.pointerId) resizeDetail(detailDrag.width + detailDrag.x - event.clientX);
});
detailResizer.addEventListener('lostpointercapture', () => {
  detailDrag = undefined;
  $('library-view').classList.remove('resizing');
});
detailResizer.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const width = $('detail').getBoundingClientRect().width;
  resizeDetail(width + (event.key === 'ArrowLeft' ? 16 : -16));
  event.preventDefault();
});
new ResizeObserver(updateDetailResizeRange).observe($('library-view'));
$('prev').addEventListener('click', () => { if (currentReader) goToPdfPage(currentReader.page - 1); });
$('next').addEventListener('click', () => { if (currentReader) goToPdfPage(currentReader.page + 1); });
$('sheet-pane').addEventListener('scroll', () => {
  if (readerScrollFrame !== undefined) return;
  readerScrollFrame = requestAnimationFrame(() => { readerScrollFrame = undefined; updateReaderViewport(); });
}, { passive: true });
$('zoom-level').addEventListener('change', event => changeZoom(event.target.value));
for (const [id, direction] of [['zoom-out', -1], ['zoom-in', 1]]) {
  $(id).addEventListener('click', () => {
    if (!currentReader) return;
    const step = zoomStep(currentReader, direction);
    if (step !== undefined) changeZoom(String(step));
  });
}
$('fulltext').addEventListener('input', setFindQuery);
$('find-next').addEventListener('click', () => { void moveFind(1); });
$('find-previous').addEventListener('click', () => { void moveFind(-1); });
$('fulltext').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); void moveFind(event.shiftKey ? -1 : 1); }
  if (event.key === 'Escape') { event.preventDefault(); $('fulltext').value = ''; setFindQuery(); $('fulltext').blur(); }
});
document.addEventListener('keydown', event => {
  if (!currentReader || $('reader-view').hidden || $('modal').open) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !$('fulltext').disabled) {
    event.preventDefault(); $('fulltext').focus(); $('fulltext').select();
  }
});
$('modal').addEventListener('close', () => { modalVersion++; });
$('close-modal').addEventListener('click', () => $('modal').close());
$('modal').addEventListener('click', event => {
  const modal = event.currentTarget;
  if (event.target !== modal) return;
  const { left, right, top, bottom } = modal.getBoundingClientRect();
  if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) modal.close();
});
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  if ($('reader-view').hidden || !currentReader) return;
  if (currentReader.zoom !== 'fit' || readerContentWidth() === requestedReaderWidth) {
    updateReaderViewport();
    return;
  }
  resizeTimer = setTimeout(() => { void renderReader(); }, 150);
}).observe($('sheet-pane'));
window.addEventListener('pagehide', () => { listAbort?.abort(); detailAbort?.abort(); stopPendingFind(); releaseReaderLayout(); for (const entry of opened.values()) void entry.task?.destroy(); });
$('home-query').focus();
