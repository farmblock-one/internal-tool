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

async function main() {
  const riskyCsvPath = process.argv[2];
  if (!riskyCsvPath) {
    console.error('Cách dùng: npm run risky -- <đường-dẫn-file-risky.csv>');
    process.exit(1);
  }

  const rows = readCsv(riskyCsvPath);
  const emails = extractEmails(rows);
  const excelPath = path.join(PROCESSED_DIR, `risky-${Date.now()}.xlsx`);
  writeRiskyExcel(excelPath, emails);
  logger.info(`Đã đổi file Risky sang Excel (chỉ cột email + 2 sheet trống): ${excelPath}`);

  const context = await openPersistentChrome();
  try {
    const teamsCurl = await fetchTeamsSearchCurl(context, DOWNLOAD_DIR);
    await uploadRiskyToMeetscript(context, teamsCurl, excelPath, DOWNLOAD_DIR, 'TEAM');

    const gmailCurl = await fetchGmailLookupCurl(context, DOWNLOAD_DIR);
    await uploadRiskyToMeetscript(context, gmailCurl, excelPath, DOWNLOAD_DIR, 'GOOGLE');
  } finally {
    await context.close();
  }

  logger.info('Hoàn tất xử lý file Risky.');
}

main().catch((err) => {
  logger.error('Lỗi khi xử lý file Risky:', err);
  process.exit(1);
});
