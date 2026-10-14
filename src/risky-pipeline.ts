import fs from 'node:fs';
import path from 'node:path';
import { openPersistentChrome } from './browser.js';
import { readCsv, extractEmails } from './csv-utils.js';
import { writeRiskyExcel } from './xlsx-utils.js';
import { fetchTeamsSearchCurl } from './teams.js';
import { fetchGmailLookupCurl } from './gmail.js';
import { uploadRiskyToMeetscript } from './meetscript.js';
import { logger } from './logger.js';

const DOWNLOAD_DIR = path.resolve('data/downloads');
const PROCESSED_DIR = path.resolve('data/processed');

export interface RiskyFlowResult {
  excelPath: string;
  teamResultScreenshot: string;
  googleResultScreenshot: string;
}

/**
 * Xử lý 1 file Risky: đổi sang Excel, bắt cURL Teams + Gmail, rồi upload lần lượt lên 2 tab
 * TEAM/GOOGLE của meetscript.io. Trả về `null` nếu file Risky rỗng (không có lead nào) — không
 * cần tốn công bắt cURL/upload cho 1 danh sách trống.
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

  const excelPath = path.join(PROCESSED_DIR, `risky-${Date.now()}.xlsx`);
  writeRiskyExcel(excelPath, emails);
  logger.info(`Đã đổi file Risky sang Excel (chỉ cột email + 2 sheet trống): ${excelPath}`);

  const context = await openPersistentChrome();
  try {
    const teamsCurl = await fetchTeamsSearchCurl(context, DOWNLOAD_DIR);
    // Lưu cURL ra file riêng (KHÔNG in thẳng ra log/chat — có chứa token đăng nhập thật) để tự
    // kiểm tra đối chiếu với 1 cURL mẫu đã biết là hợp lệ, qua scp tải về máy, không qua bên nào khác.
    const teamsCurlPath = path.join(PROCESSED_DIR, `teams-curl-${Date.now()}.txt`);
    fs.writeFileSync(teamsCurlPath, teamsCurl);
    logger.info(`Đã lưu cURL Teams để kiểm tra: ${teamsCurlPath}`);
    const teamResultScreenshot = await uploadRiskyToMeetscript(context, teamsCurl, excelPath, DOWNLOAD_DIR, 'TEAM');

    const gmailCurl = await fetchGmailLookupCurl(context, DOWNLOAD_DIR);
    const gmailCurlPath = path.join(PROCESSED_DIR, `gmail-curl-${Date.now()}.txt`);
    fs.writeFileSync(gmailCurlPath, gmailCurl);
    logger.info(`Đã lưu cURL Gmail để kiểm tra: ${gmailCurlPath}`);
    const googleResultScreenshot = await uploadRiskyToMeetscript(context, gmailCurl, excelPath, DOWNLOAD_DIR, 'GOOGLE');

    logger.info('Hoàn tất xử lý file Risky.');
    return { excelPath, teamResultScreenshot, googleResultScreenshot };
  } finally {
    await context.close();
  }
}
