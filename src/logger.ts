import util from 'node:util';
import { jobContext } from './job-context.js';

function timestamp(): string {
  return new Date().toISOString();
}

/** Định dạng các tham số log thành 1 dòng text — dùng util.inspect cho object/mảng thay vì "[object Object]". */
function toLine(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4 }))).join(' ');
}

function emit(consoleFn: (...a: unknown[]) => void, args: unknown[]): void {
  const ts = `[${timestamp()}]`;
  consoleFn(ts, ...args);
  // Nếu đang chạy trong 1 job của web UI (xem job-context.ts), góp thêm dòng log này vào đó.
  jobContext.getStore()?.append(`${ts} ${toLine(args)}`);
}

export const logger = {
  info: (...args: unknown[]) => emit(console.log, args),
  warn: (...args: unknown[]) => emit(console.warn, args),
  error: (...args: unknown[]) => emit(console.error, args),
};
