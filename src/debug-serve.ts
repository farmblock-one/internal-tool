import path from 'node:path';
import { servePubliclyOnOwnServer } from './file-server.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Cách dùng: npx tsx src/debug-serve.ts <đường-dẫn-file>');
  process.exit(1);
}

const handle = await servePubliclyOnOwnServer(path.resolve(filePath));
console.log('Đang phục vụ file tại:', handle.url);
console.log('Nhấn Ctrl+C để dừng.');
