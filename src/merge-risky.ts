import { mergeRiskyResultsIntoMaster } from './risky-merge.js';
import { sendDocumentToTelegram } from './telegram-watcher.js';
import { uploadFinalXlsxToDrive } from './drive.js';
import { config } from './config.js';
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

async function main() {
  const stats = mergeRiskyResultsIntoMaster(masterXlsxPath, [
    { kind: 'TEAM', filePath: teamFilePath },
    { kind: 'GOOGLE', filePath: googleFilePath },
  ]);
  logger.info('Hoàn tất ghép tay.');

  // Gửi luôn lên Telegram giống hệt luồng tự động — khỏi phải tự scp file xuống máy để kiểm tra.
  if (config.telegramBotToken && config.telegramChatId) {
    try {
      await sendDocumentToTelegram(
        masterXlsxPath,
        `✅ Đã cập nhật kết quả Risky (ghép tay): ${stats.updatedCount} lead (Safe to Send/Do not Send)` +
          (stats.noMatchCount > 0 ? `, ${stats.noMatchCount} lead chưa khớp được kết quả` : '') +
          '.',
      );
      logger.info('Đã gửi file Excel gốc (đã cập nhật) vào group Telegram.');
    } catch (err) {
      logger.error('Ghép tay thành công nhưng gửi lại Telegram thất bại — tự tải file qua scp thay thế:', err);
    }
  } else {
    logger.info('Chưa cấu hình TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID — bỏ qua bước gửi lại Telegram, tự tải file qua scp.');
  }

  try {
    await uploadFinalXlsxToDrive(masterXlsxPath);
  } catch (err) {
    logger.error('Ghép tay thành công nhưng upload lên Google Drive thất bại:', err);
  }
}

main().catch((err) => {
  logger.error('Lỗi khi ghép tay:', err);
  process.exit(1);
});
