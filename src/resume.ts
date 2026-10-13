import { runFromDebounceResult } from './pipeline.js';
import { logger } from './logger.js';

const debounceResultPath = process.argv[2];
const outputFileName = process.argv[3];
if (!debounceResultPath) {
  console.error('Cách dùng: npm run resume -- <đường-dẫn-file-debounce-result.csv> [tên-file-output]');
  process.exit(1);
}

runFromDebounceResult(debounceResultPath, undefined, outputFileName)
  .then((result) => {
    logger.info('Kết quả:', result);
  })
  .catch((err) => {
    logger.error('Luồng automation lỗi:', err);
    process.exit(1);
  });
