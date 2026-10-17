import { mergeRiskyResultsIntoMaster } from './risky-merge.js';
import { logger } from './logger.js';

const [masterXlsxPath, teamFilePath, googleFilePath] = process.argv.slice(2);

if (!masterXlsxPath || !teamFilePath || !googleFilePath) {
  console.error(
    'Cách dùng: npm run merge-risky -- <file-excel-goc.xlsx> <file-ket-qua-TEAM.xlsx> <file-ket-qua-GOOGLE.xlsx>\n\n' +
      'Dùng khi tool KHÔNG tự ghép được kết quả Risky vào file Excel gốc (vd 2 file kết quả Team/\n' +
      'Google đã tới Telegram nhưng bị bỏ lỡ không tự bắt được) — ghép TAY bằng đúng logic tự động\n' +
      '(Safe to Send nếu ít nhất 1 trong 2 file TRUE, Do not Send nếu cả 2 FALSE), áp dụng cho các\n' +
      'row đang là "Risky" trong file Excel gốc.',
  );
  process.exit(1);
}

try {
  mergeRiskyResultsIntoMaster(masterXlsxPath, [
    { kind: 'TEAM', filePath: teamFilePath },
    { kind: 'GOOGLE', filePath: googleFilePath },
  ]);
  logger.info('Hoàn tất ghép tay.');
} catch (err) {
  logger.error('Lỗi khi ghép tay:', err);
  process.exit(1);
}
