import { mergeRiskyResultsIntoMaster, type MergeFileRef } from './risky-merge.js';
import { sendDocumentToTelegram } from './telegram-watcher.js';
import { uploadFinalXlsxToDrive } from './drive.js';
import { runApolloReimport } from './apollo-reimport.js';
import { config } from './config.js';
import { logger } from './logger.js';

const [masterXlsxPath, ...fileArgs] = process.argv.slice(2);

// 2 cách gọi:
//   npm run merge-risky -- <goc.xlsx> <TEAM.xlsx> <GOOGLE.xlsx>            (cách cũ, 1 phần)
//   npm run merge-risky -- <goc.xlsx> TEAM:<a.xlsx> TEAM:<b.xlsx> GOOGLE:<c.xlsx> ...  (nhiều phần)
function parseResultFiles(args: string[]): MergeFileRef[] | null {
  if (args.length === 0) return null;
  const tagged = args.every((a) => /^(TEAM|GOOGLE):.+/i.test(a));
  if (tagged) {
    return args.map((a) => {
      const idx = a.indexOf(':');
      return { kind: a.slice(0, idx).toUpperCase() as 'TEAM' | 'GOOGLE', filePath: a.slice(idx + 1) };
    });
  }
  if (args.length === 2) {
    return [
      { kind: 'TEAM', filePath: args[0] },
      { kind: 'GOOGLE', filePath: args[1] },
    ];
  }
  return null;
}

const resultFiles = masterXlsxPath ? parseResultFiles(fileArgs) : null;

if (!masterXlsxPath || !resultFiles) {
  console.error(
    'Cách dùng:\n' +
      '  npm run merge-risky -- <file-excel-goc.xlsx> <file-ket-qua-TEAM.xlsx> <file-ket-qua-GOOGLE.xlsx>\n' +
      '  npm run merge-risky -- <file-excel-goc.xlsx> TEAM:<file1.xlsx> TEAM:<file2.xlsx> GOOGLE:<file3.xlsx> ...\n\n' +
      'Dùng khi tool KHÔNG tự ghép được kết quả Risky vào file Excel gốc — ghép TAY bằng đúng logic tự\n' +
      'động (Safe to Send nếu ít nhất 1 bên TRUE, Do not Send nếu các bên có kết quả đều FALSE), áp\n' +
      'dụng cho các row đang là "Risky" trong file Excel gốc. Cách thứ 2 dùng khi list bị tách nhiều\n' +
      'phần, hoặc thiếu kết quả của 1 bên.',
  );
  process.exit(1);
}

async function main() {
  const stats = mergeRiskyResultsIntoMaster(masterXlsxPath, resultFiles!);
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

  // ⚠️ Dùng CHUNG profile Chrome Apollo với job export — KHÔNG chạy lệnh này đồng thời lúc web UI
  // (`npm run web`) đang có job Apollo export/import khác chạy (2 Chrome cùng 1 profile sẽ tranh
  // khoá/crash nhau). Lệnh này không qua được hàng đợi của web UI vì chạy ở tiến trình riêng.
  try {
    await runApolloReimport(masterXlsxPath);
  } catch (err) {
    logger.error('Ghép tay thành công nhưng import lại Apollo thất bại:', err);
  }
}

main().catch((err) => {
  logger.error('Lỗi khi ghép tay:', err);
  process.exit(1);
});
