// Huỷ job đang chạy (bước export Apollo + lọc Debounce) từ web UI. Dùng AbortSignal chuẩn của Node:
// web UI gọi `controller.abort()`, luồng chạy tự kiểm tra ở các điểm an toàn và dừng bằng
// `JobCancelledError`.

export class JobCancelledError extends Error {
  constructor() {
    super('Job đã bị huỷ theo yêu cầu.');
    this.name = 'JobCancelledError';
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new JobCancelledError();
}

/** Chờ `ms` mili-giây, nhưng dừng ngay (ném JobCancelledError) nếu bị huỷ giữa chừng. */
export function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new JobCancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JobCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
