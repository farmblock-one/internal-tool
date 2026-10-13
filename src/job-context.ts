import { AsyncLocalStorage } from 'node:async_hooks';

export interface JobLogSink {
  append(line: string): void;
}

/**
 * Cho phép `logger.ts` biết "đang chạy trong job nào" (nếu có) mà KHÔNG phải sửa hàng chục chỗ
 * gọi logger.info/warn/error rải rác khắp apollo.ts/debounce.ts/teams.ts/gmail.ts/meetscript.ts...
 * — web server (server.ts) bọc mỗi lần chạy `runFlow` trong `jobContext.run(sink, fn)`, nhờ đó
 * MỌI log bên trong (kể cả từ các module khác gọi tới) tự động được góp vào đúng log của job đó
 * để hiện lên trang trạng thái. Khi chạy ngoài job (CLI thường như `npm run flow`), getStore()
 * trả về undefined — không ảnh hưởng gì tới hành vi log ra console như trước.
 */
export const jobContext = new AsyncLocalStorage<JobLogSink>();
