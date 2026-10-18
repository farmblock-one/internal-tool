import fs from 'node:fs';
import { uploadFinalXlsxToDrive } from './drive.js';
import { logger } from './logger.js';

const [filePath] = process.argv.slice(2);

if (!filePath) {
  console.error(
    'Cách dùng: npm run upload-drive -- <đường-dẫn-file-excel.xlsx>\n\n' +
      'Upload TAY 1 file Excel lên đúng folder Google Drive đã cấu hình (GDRIVE_SAFE_TO_SEND_FOLDER_ID) —\n' +
      'dùng khi cần đẩy ngay 1 file đã có sẵn, không cần chạy lại cả job.',
  );
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`Không tìm thấy file: ${filePath}`);
  process.exit(1);
}

uploadFinalXlsxToDrive(filePath)
  .then(() => {
    logger.info('Hoàn tất upload Drive.');
  })
  .catch((err) => {
    logger.error('Lỗi khi upload lên Google Drive:', err);
    process.exit(1);
  });
