import path from 'node:path';
import { openPersistentChrome } from './browser.js';
import { readCsv } from './csv-utils.js';
import { writeXlsx } from './xlsx-utils.js';
import { fetchTeamsSearchCurl } from './teams.js';
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
  const excelPath = path.join(PROCESSED_DIR, `risky-${Date.now()}.xlsx`);
  writeXlsx(excelPath, rows);
  logger.info(`Đã đổi file Risky sang Excel: ${excelPath}`);

  const context = await openPersistentChrome();
  try {
    const curlCommand = await fetchTeamsSearchCurl(context);
    await uploadRiskyToMeetscript(context, curlCommand, excelPath, DOWNLOAD_DIR);
  } finally {
    await context.close();
  }

  logger.info('Hoàn tất xử lý file Risky.');
}

main().catch((err) => {
  logger.error('Lỗi khi xử lý file Risky:', err);
  process.exit(1);
});
