import { execSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

export interface PublicFileHandle {
  /** URL công khai (https, thẳng vào IP của server này) trỏ tới file. */
  url: string;
  close: () => Promise<void>;
}

const CERT_DIR = path.resolve('.tls');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');

/** Tạo self-signed certificate 1 lần (dùng lại cho các lần chạy sau) bằng openssl có sẵn trên hệ thống. */
function ensureSelfSignedCert(): void {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) return;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  logger.info('Đang tạo self-signed TLS certificate (chỉ 1 lần, dùng lại cho các lần sau)...');
  execSync(
    `openssl req -x509 -nodes -days 3650 -newkey rsa:2048 ` +
      `-keyout "${KEY_PATH}" -out "${CERT_PATH}" -subj "/CN=${config.publicHost}"`,
    { stdio: 'ignore' },
  );
}

/**
 * Debounce yêu cầu file phải được host trên "server của chính bạn" (không chấp nhận Google
 * Drive/Dropbox...). Hàm này mở thẳng 1 HTTPS server (certificate tự ký) trên IP công khai của
 * chính VM này — không dùng phần mềm tunnel/proxy của bên thứ ba nào.
 *
 * Yêu cầu: đã mở port này trên firewall của VM (xem README), và đã set PUBLIC_HOST +
 * FILE_SERVE_PORT trong .env.
 */
export async function servePubliclyOnOwnServer(filePath: string): Promise<PublicFileHandle> {
  ensureSelfSignedCert();
  const fileName = path.basename(filePath);
  const port = config.fileServePort;

  const server = https.createServer(
    {
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH),
    },
    (req, res) => {
      if (req.url === `/${fileName}`) {
        res.setHeader('Content-Type', 'text/csv');
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.statusCode = 404;
        res.end('Not found');
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });

  const url = `https://${config.publicHost}:${port}/${fileName}`;
  logger.info(`Đã mở HTTPS server công khai tại: ${url}`);
  logger.warn(
    'Dùng certificate tự ký (self-signed) — nếu Debounce từ chối vì lỗi TLS, cần chuyển sang certificate hợp lệ (vd Let\'s Encrypt với 1 domain trỏ vào IP này).',
  );

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { url, close };
}
