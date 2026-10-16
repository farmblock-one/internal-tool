import fs from 'node:fs';
import path from 'node:path';
import { openPersistentChrome } from './browser.js';
import { readCsv, extractEmails } from './csv-utils.js';
import { writeRiskyExcel } from './xlsx-utils.js';
import { fetchTeamsSearchCurl } from './teams.js';
import { fetchGmailLookupCurl } from './gmail.js';
import { uploadRiskyToMeetscript } from './meetscript.js';
import { registerExpectedTelegramFile } from './telegram-watcher.js';
import { logger } from './logger.js';

const DOWNLOAD_DIR = path.resolve('data/downloads');
const PROCESSED_DIR = path.resolve('data/processed');

// meetscript.io chỉ nhận tối đa 1000 dòng (lead) cho 1 lần chạy — vượt quá phải tách thành nhiều
// file nhỏ, chạy lần lượt từng file.
const MAX_ROWS_PER_RUN = 1000;

export interface RiskyChunkResult {
  excelPath: string;
  teamResultScreenshot: string;
  googleResultScreenshot: string;
}

export interface RiskyFlowResult {
  chunks: RiskyChunkResult[];
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Xử lý 1 file Risky: đổi sang Excel (tự tách thành nhiều phần nếu vượt quá 1000 lead/phần —
 * giới hạn của meetscript.io), bắt cURL Teams + Gmail 1 LẦN DUY NHẤT (phiên đăng nhập dùng chung
 * được cho mọi phần đã tách), rồi upload lần lượt từng phần lên 2 tab TEAM/GOOGLE của
 * meetscript.io. Trả về `null` nếu file Risky rỗng (không có lead nào).
 */
export async function runRiskyFlow(riskyCsvPath: string): Promise<RiskyFlowResult | null> {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });

  const rows = readCsv(riskyCsvPath);
  const emails = extractEmails(rows);
  if (emails.length === 0) {
    logger.info('File Risky không có lead nào — bỏ qua bước bắt cURL/upload meetscript.io.');
    return null;
  }

  const emailChunks = chunkArray(emails, MAX_ROWS_PER_RUN);
  const ts = Date.now();
  if (emailChunks.length > 1) {
    logger.info(
      `File Risky có ${emails.length} lead, vượt giới hạn ${MAX_ROWS_PER_RUN}/lần của meetscript.io — ` +
        `tự động tách thành ${emailChunks.length} file nhỏ để chạy lần lượt.`,
    );
  }

  const context = await openPersistentChrome();
  try {
    // Bắt cURL Teams/Gmail CHỈ 1 LẦN rồi dùng chung cho mọi phần đã tách — phiên đăng nhập không
    // phụ thuộc nội dung file Excel đính kèm, tách nhỏ bao nhiêu phần cũng chỉ cần bắt 1 lần.
    const teamsCurl = await fetchTeamsSearchCurl(context, DOWNLOAD_DIR);
    const teamsCurlPath = path.join(PROCESSED_DIR, `teams-curl-${ts}.txt`);
    fs.writeFileSync(teamsCurlPath, teamsCurl);
    logger.info(`Đã lưu cURL Teams để kiểm tra: ${teamsCurlPath}`);

    const gmailCurl = await fetchGmailLookupCurl(context, DOWNLOAD_DIR);
    const gmailCurlPath = path.join(PROCESSED_DIR, `gmail-curl-${ts}.txt`);
    fs.writeFileSync(gmailCurlPath, gmailCurl);
    logger.info(`Đã lưu cURL Gmail để kiểm tra: ${gmailCurlPath}`);

    const chunks: RiskyChunkResult[] = [];
    for (const [index, chunkEmails] of emailChunks.entries()) {
      const suffix = emailChunks.length > 1 ? `-part${index + 1}` : '';
      const excelPath = path.join(PROCESSED_DIR, `risky-${ts}${suffix}.xlsx`);
      writeRiskyExcel(excelPath, chunkEmails);
      logger.info(`Đã đổi phần ${index + 1}/${emailChunks.length} (${chunkEmails.length} lead) sang Excel: ${excelPath}`);

      const teamResultScreenshot = await uploadRiskyToMeetscript(context, teamsCurl, excelPath, DOWNLOAD_DIR, 'TEAM');
      // Đăng ký "sổ chờ" ngay sau khi upload thành công — bộ phận theo dõi Telegram (chạy nền,
      // tách biệt) sẽ tự nhận diện + tải file kết quả thật khi bot meetscript.io gửi vào group.
      registerExpectedTelegramFile(excelPath, 'TEAM');

      const googleResultScreenshot = await uploadRiskyToMeetscript(context, gmailCurl, excelPath, DOWNLOAD_DIR, 'GOOGLE');
      registerExpectedTelegramFile(excelPath, 'GOOGLE');

      chunks.push({ excelPath, teamResultScreenshot, googleResultScreenshot });
    }

    logger.info('Hoàn tất xử lý file Risky.');
    return { chunks };
  } finally {
    await context.close();
  }
}
