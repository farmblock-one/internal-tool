import { runFlow } from './pipeline.js';
import { logger } from './logger.js';

const listUrl = process.argv[2];
if (!listUrl) {
  console.error('Cách dùng: npm run flow -- <apollo_list_url>');
  process.exit(1);
}

runFlow(listUrl)
  .then((result) => {
    logger.info('Kết quả:', result);
  })
  .catch((err) => {
    logger.error('Luồng automation lỗi:', err);
    process.exit(1);
  });
