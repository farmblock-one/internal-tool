// Kiểm tra file Excel cuối có được ghép ĐÚNG từ file Apollo + kết quả Debounce không, so TỪNG DÒNG:
//   npm run verify-merge -- <file-excel-cuoi.xlsx> <debounce-result-*.csv> <apollo-export-cleaned-*.csv>
//
// Kiểm tra:
//   1. Số dòng: file Excel có đúng bằng số lead trong file Apollo (đã làm sạch) không.
//   2. Cột gốc Apollo: mọi ô của từng lead trong file Excel giống hệt file Apollo không (không lệch dòng).
//   3. Cột RESULT: khớp với kết quả Debounce của đúng email đó không. Riêng lead Debounce trả "Risky"
//      được phép đã đổi thành "Safe to Send"/"Do not Send" (bước ghép kết quả Teams/Google).
import path from 'node:path';
import { readCsv, findColumn, dedupeDebounceResults, type Row } from './csv-utils.js';
import { readXlsxRows } from './xlsx-utils.js';

const [xlsxPath, debouncePath, apolloPath] = process.argv.slice(2);
if (!xlsxPath || !debouncePath || !apolloPath) {
  console.error(
    'Cách dùng: npm run verify-merge -- <file-excel-cuoi.xlsx> <debounce-result-*.csv> <apollo-export-cleaned-*.csv>',
  );
  process.exit(1);
}

const MAX_EXAMPLES = 10;
const norm = (v: unknown) => String(v ?? '').trim();
const key = (v: unknown) => norm(v).toLowerCase();

const finalRows = readXlsxRows(xlsxPath, 'Leads');
// Cùng quy tắc với tool: email lặp trong kết quả Debounce giữ kết quả rõ ràng hơn "Unknown".
const debounceRows = dedupeDebounceResults(readCsv(debouncePath)).rows;
const apolloRows = readCsv(apolloPath);

const finalEmailCol = findColumn(finalRows, ['email']);
const finalResultCol = findColumn(finalRows, ['result']);
const debounceEmailCol = findColumn(debounceRows, ['email']);
const debounceResultCol = findColumn(debounceRows, ['result']);
const apolloEmailCol = findColumn(apolloRows, ['email']);

const debounceByEmail = new Map<string, string>();
for (const r of debounceRows) {
  const email = key(r[debounceEmailCol]);
  if (email) debounceByEmail.set(email, norm(r[debounceResultCol]));
}

console.log(`File Excel cuối : ${path.basename(xlsxPath)} (${finalRows.length} dòng)`);
console.log(`Kết quả Debounce: ${path.basename(debouncePath)} (${debounceRows.length} email)`);
console.log(`File Apollo     : ${path.basename(apolloPath)} (${apolloRows.length} lead)\n`);

let problems = 0;

// 1. Số dòng
if (finalRows.length === apolloRows.length) {
  console.log(`✅ Số dòng khớp: ${finalRows.length}`);
} else {
  problems++;
  console.log(`❌ Số dòng KHÁC: Excel ${finalRows.length} / Apollo ${apolloRows.length}`);
}

// 2. Cột gốc Apollo — so theo thứ tự dòng (bước ghép giữ nguyên thứ tự file Apollo).
const apolloCols = Object.keys(apolloRows[0] ?? {});
const missingCols = apolloCols.filter((c) => !(c in (finalRows[0] ?? {})));
if (missingCols.length > 0) {
  problems++;
  console.log(`❌ File Excel thiếu ${missingCols.length} cột Apollo: ${missingCols.join(', ')}`);
}
const cellMismatches: string[] = [];
let cellMismatchCount = 0;
const n = Math.min(finalRows.length, apolloRows.length);
for (let i = 0; i < n; i++) {
  for (const col of apolloCols) {
    if (missingCols.includes(col)) continue;
    if (norm(finalRows[i][col]) !== norm(apolloRows[i][col])) {
      cellMismatchCount++;
      if (cellMismatches.length < MAX_EXAMPLES) {
        cellMismatches.push(
          `   dòng ${i + 2}, cột "${col}": Excel="${norm(finalRows[i][col]).slice(0, 60)}" / Apollo="${norm(apolloRows[i][col]).slice(0, 60)}"`,
        );
      }
    }
  }
}
if (cellMismatchCount === 0) {
  console.log(`✅ ${apolloCols.length} cột gốc Apollo giống hệt file Apollo ở cả ${n} dòng (không lệch dòng)`);
} else {
  problems++;
  console.log(`❌ ${cellMismatchCount} ô cột Apollo khác file gốc. Ví dụ:\n${cellMismatches.join('\n')}`);
}

// 3. Cột RESULT so với Debounce theo email
let same = 0;
let riskyResolved = 0;
let noEmail = 0;
const notInDebounce: string[] = [];
const wrong: string[] = [];
const byFinalValue = new Map<string, number>();
for (let i = 0; i < finalRows.length; i++) {
  const row: Row = finalRows[i];
  const email = key(row[finalEmailCol]);
  const finalResult = norm(row[finalResultCol]);
  byFinalValue.set(finalResult || '(trống)', (byFinalValue.get(finalResult || '(trống)') ?? 0) + 1);
  if (!email) {
    noEmail++;
    continue;
  }
  const debounceResult = debounceByEmail.get(email);
  if (debounceResult === undefined) {
    notInDebounce.push(`   dòng ${i + 2}: ${email} (RESULT trong Excel: "${finalResult}")`);
    continue;
  }
  if (finalResult.toLowerCase() === debounceResult.toLowerCase()) {
    same++;
  } else if (debounceResult.toLowerCase() === 'risky' && /^(safe to send|do not send)$/i.test(finalResult)) {
    riskyResolved++;
  } else {
    wrong.push(`   dòng ${i + 2}: ${email} — Excel="${finalResult}" / Debounce="${debounceResult}"`);
  }
}

console.log(`✅ ${same} lead có RESULT đúng y kết quả Debounce`);
console.log(`✅ ${riskyResolved} lead Risky đã được cập nhật thành Safe to Send/Do not Send (kết quả Teams/Google)`);
if (noEmail > 0) console.log(`ℹ️  ${noEmail} lead không có email (không gửi Debounce, RESULT để trống là đúng)`);
if (notInDebounce.length > 0) {
  problems++;
  console.log(`❌ ${notInDebounce.length} email có trong Excel nhưng KHÔNG có trong kết quả Debounce. Ví dụ:\n${notInDebounce.slice(0, MAX_EXAMPLES).join('\n')}`);
}
if (wrong.length > 0) {
  problems++;
  console.log(`❌ ${wrong.length} lead có RESULT KHÁC Debounce (không phải do cập nhật Risky). Ví dụ:\n${wrong.slice(0, MAX_EXAMPLES).join('\n')}`);
}

console.log('\nPhân bố cột RESULT trong file Excel:');
for (const [value, count] of [...byFinalValue.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${value}: ${count}`);
}

console.log(problems === 0 ? '\n🎉 KẾT LUẬN: file Excel được ghép ĐÚNG.' : `\n⚠️  KẾT LUẬN: có ${problems} loại vấn đề, xem chi tiết ở trên.`);
process.exit(problems === 0 ? 0 : 2);
