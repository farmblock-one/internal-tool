import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

export interface PublicFileHandle {
  /** URL công khai (https, cổng 443 chuẩn qua nginx reverse-proxy) trỏ tới file. */
  url: string;
  close: () => Promise<void>;
}

/**
 * Debounce yêu cầu file phải được host trên "server của chính bạn" (không chấp nhận Google
 * Drive/Dropbox...) và có vẻ không chấp nhận cổng khác 443. Vì port 443 trên VM này đã có nginx
 * dùng cho dịch vụ khác (n8n), hàm này chỉ mở 1 server HTTP thường ở localhost — nginx sẽ đảm
 * nhận việc chấp nhận HTTPS ở cổng 443 (dùng tên miền riêng qua SNI) và chuyển tiếp vào đây.
 * Xem README/hướng dẫn cấu hình nginx reverse-proxy tương ứng.
 *
 * Yêu cầu: đã cấu hình 1 server block nginx trỏ https://<PUBLIC_HOST> -> http://127.0.0.1:<FILE_SERVE_PORT>.
 */
export async function servePubliclyOnOwnServer(filePath: string): Promise<PublicFileHandle> {
  const fileName = path.basename(filePath);
  const port = config.fileServePort;

  const server = http.createServer((req, res) => {
    if (req.url === `/${fileName}`) {
      res.setHeader('Content-Type', 'text/csv');
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const url = `https://${config.publicHost}/${fileName}`;
  logger.info(`Server nội bộ đã sẵn sàng tại 127.0.0.1:${port}, nginx phục vụ công khai tại: ${url}`);

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { url, close };
}
