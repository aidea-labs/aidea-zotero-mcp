/** 将浏览器静态资源放到 TypeScript 构建产物旁边。 */
import { cp } from 'node:fs/promises';

await cp(new URL('../src/ui/', import.meta.url), new URL('../dist/ui/', import.meta.url), { recursive: true });
