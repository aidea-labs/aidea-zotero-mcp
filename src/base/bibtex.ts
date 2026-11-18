/** 用同一转换器导出两adapter的数据，引用键稳定，歧义时明确返回冲突。 */
import type { Item, BibtexResult } from './types.js';
import { citationKey, itemYear } from './normalize.js';
import { ZoteroError } from './errors.js';

function escapeBibtex(value: string): string {
  const chars: Record<string, string> = {
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '&': '\\&',
    '%': '\\%', '#': '\\#', '_': '\\_', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
  };
  return value.replace(/[\\{}&%#_~^]/g, char => chars[char]!).replace(/[\r\n]+/g, ' ');
}
export function exportBibtex(items: Item[]): BibtexResult {
  const keys = new Map<string, string>();
  const entries = items.map(item => {
    const key = citationKey(item);
    if (!/^[^\s{},=]+$/.test(key)) throw new ZoteroError('invalid_citation_key', '引用键包含 BibTeX 不支持的字符。');
    const identity = JSON.stringify(item.ref);
    if (keys.has(key) && keys.get(key) !== identity) {
      throw new ZoteroError('citation_key_conflict', '多篇论文使用同一引用键，请先明确区分。');
    }
    keys.set(key, identity);
    const types: Record<string, string> = { journalArticle: 'article', book: 'book', bookSection: 'incollection',
      conferencePaper: 'inproceedings', thesis: 'phdthesis', report: 'techreport' };
    const fields: [string, string][] = [['title', escapeBibtex(item.title)]];
    for (const [role, label] of [['author', 'author'], ['editor', 'editor']] as const) {
      const names = item.creators.filter(c => c.role === role).map(c => c.name
        ? '{' + escapeBibtex(c.name) + '}' : escapeBibtex(c.lastName) + (c.firstName ? ', ' + escapeBibtex(c.firstName) : ''));
      if (names.length) fields.push([label, names.join(' and ')]);
    }
    const mappings: Record<string, string> = { volume: 'volume', issue: 'number', pages: 'pages', DOI: 'doi',
      ISBN: 'isbn', url: 'url', publisher: 'publisher', place: 'address', edition: 'edition' };
    for (const [source, target] of Object.entries(mappings)) {
      if (item.fields[source]) fields.push([target, escapeBibtex(item.fields[source])]);
    }
    if (itemYear(item)) fields.push(['year', String(itemYear(item))]);
    const publication = item.fields.publicationTitle || item.fields.bookTitle || item.fields.proceedingsTitle;
    if (publication) fields.push([item.type === 'journalArticle' ? 'journal' : 'booktitle', escapeBibtex(publication)]);
    if (item.fields.university) fields.push(['school', escapeBibtex(item.fields.university)]);
    return '@' + (types[item.type] ?? 'misc') + '{' + key + ',\n'
      + fields.map(([name, value]) => '  ' + name + ' = {' + value + '}').join(',\n') + '\n}';
  });
  return { bibtex: entries.join('\n\n') + '\n', keys: [...keys.keys()], count: entries.length };
}
