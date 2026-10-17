import { openPersistentChrome } from './browser.js';
import { runRiskyFlow } from './risky-pipeline.js';
import { config } from './config.js';
import { logger } from './logger.js';

const riskyCsvPath = process.argv[2];
if (!riskyCsvPath) {
  console.error('Cách dùng: npm run risky -- <đường-dẫn-file-risky.csv>');
  process.exit(1);
}

async function main() {
  const context = await openPersistentChrome(config.riskyChromeUserDataDir);
  try {
    const result = await runRiskyFlow(riskyCsvPath, context);
    if (result === null) {
      logger.info('Không có lead Risky nào, không cần xử lý gì thêm.');
    } else {
      logger.info('Kết quả:', result);
    }
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  logger.error('Lỗi khi xử lý file Risky:', err);
  process.exit(1);
});
