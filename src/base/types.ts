/** base 是两种读取方式共用的约定，相当于 Python Protocol 与 dataclass。 */
/** 个人库仅用本机别名 user:0；群组的正整数范围由 parseLibraryId 在运行时检查。 */
export type LibraryId = 'user:0' | `group:${number}`;
export interface ItemRef { library: LibraryId; key: string }
export interface Creator { firstName: string; lastName: string; name: string; role: string }
export interface Item {
  ref: ItemRef;
  type: string;
  title: string;
  fields: Record<string, string>;
  creators: Creator[];
  tags: string[];
  collections: string[];
  parentKey: string | null;
  version: number | null;
}
export interface Note { ref: ItemRef; parentKey: string; format: 'html'; content: string }
export interface Collection { key: string; name: string; parentKey: string | null }
export interface Attachment {
  ref: ItemRef;
  parentKey: string | null;
  title: string;
  mimeType: string;
  linkMode: string;
  /** 本地位置由 adapter 解析，不能由模型直接指定任意路径。 */
  path: string | null;
  available: boolean;
}
export interface Source { backend: 'api' | 'database'; identity: string; observedAt: string }
export interface Sourced<T> { source: Source; value: T }
export interface Adapter {
  readonly source: Source;
  collections(library: LibraryId, signal: AbortSignal): Promise<Collection[]>;
  items(library: LibraryId, collection: string | undefined, signal: AbortSignal): AsyncIterable<Item>;
  item(ref: ItemRef, signal: AbortSignal): Promise<Item>;
  attachments(ref: ItemRef, signal: AbortSignal): Promise<Attachment[]>;
  notes(ref: ItemRef, signal: AbortSignal): Promise<Note[]>;
  close(): Promise<void>;
}
export interface OpenRequest { attachment: ItemRef; uri: string; page: number }
export interface Reader {
  /** 注入宿主真实打开能力，成功后才报告 opened。 */
  open(request: OpenRequest, signal: AbortSignal): Promise<void>;
}

/** 共用服务通过此接口取得当前数据源，装配位置决定具体 adapter。 */
export interface AdapterAccess {
  use<T>(operation: (adapter: Adapter) => Promise<T>, signal: AbortSignal): Promise<Sourced<T>>;
}

/** 共用输入/输出合同。MCP 和页面入口可各自解析参数，返回字段由同一合同约束。 */
export interface Search {
  library: LibraryId; query: string; author?: string | undefined;
  yearFrom?: number | undefined; yearTo?: number | undefined;
  tag?: string | undefined; collection?: string | undefined; limit: number; offset: number;
}
export interface SearchResult {
  items: Item[]; matched: number; scanned: number; scanLimitReached: boolean;
  nextOffset: number | null; notice: string | null;
}
export interface ResolveInput { library: LibraryId; query: string; limit: number }
export type ResolveStatus = 'matched' | 'candidates' | 'not_found';
export interface ResolveResult {
  status: ResolveStatus; items: Item[]; candidateCount: number; scanLimitReached: boolean;
}
export interface NotesResult { notes: Note[]; notice: string }
export interface PdfReference {
  uri: string; name: string; mimeType: 'application/pdf'; attachment: ItemRef; path: string; fileUrl: string;
}
export interface PdfFile extends PdfReference { bytes: number }
/** blob 是文件字节的 Base64，保持 MCP resources/read 使用的结构。 */
export interface PdfResource { uri: string; mimeType: 'application/pdf'; blob: string }
export interface PdfMatch { page: number; text: string }
export interface PdfSearchResult {
  matches: PdfMatch[]; totalPages: number; startPage: number; scannedThrough: number;
  nextPage: number | null; noTextPages: number[]; pageNumbering: 'pdf-1-based'; notice: string | null;
}
export interface FulltextInput {
  refs: ItemRef[]; query: string; startPage: number; maxPages: number; maxMatches: number;
}
export interface FulltextResult {
  results: (PdfSearchResult & { attachment: ItemRef })[]; notice: string;
}
export interface BibtexResult { bibtex: string; keys: string[]; count: number }
/** status 决定其他字段，调用方必须区分“待宿主打开”和“实际已打开”。 */
export type OpenResult = {
  status: 'host_required'; request: OpenRequest; notice: string; resource: PdfReference;
} | {
  status: 'opened'; attachment: ItemRef; page: number;
};
