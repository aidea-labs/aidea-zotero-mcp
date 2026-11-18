/** 可给模型和用户的固定错误，避免把 HTTP 返回正文或私有路径写入诊断。 */
export class ZoteroError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function required<T>(value: T | null | undefined, code: string, message: string): T {
  if (value == null) throw new ZoteroError(code, message);
  return value;
}
