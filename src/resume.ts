import { runFromDebounceResult } from './pipeline.js';
import { logger } from './logger.js';

const debounceResultPath = process.argv[2];
const outputFileName = process.argv[3];
// File "apollo-export-cleaned-*.csv" tương ứng (lưu ở data/processed/ cùng lúc với file debounce-
// result-*.csv) — truyền vào để file Excel cuối ghép đủ cột Apollo gốc, không bắt buộc.
const apolloRowsPath = process.argv[4];
if (!debounceResultPath) {
  console.error(
    'Cách dùng: npm run resume -- <đường-dẫn-file-debounce-result.csv> [tên-file-output] ' +
      '[đường-dẫn-file-apollo-export-cleaned.csv]',
  );
  process.exit(1);
}

runFromDebounceResult(debounceResultPath, undefined, outputFileName, apolloRowsPath)
  .then((result) => {
    logger.info('Kết quả:', result);
  })
  .catch((err) => {
    logger.error('Luồng automation lỗi:', err);
    process.exit(1);
  });
