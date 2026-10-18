import fs from 'node:fs';
import path from 'node:path';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import input from 'input';
import { config } from './config.js';

const ENV_FILE = path.resolve('.env');

/**
 * Ghi/thay thế thẳng dòng TELEGRAM_USER_SESSION= trong file .env — tự động, KHÔNG bắt người dùng
 * phải tự copy/dán 1 chuỗi rất dài từ terminal (dễ copy thiếu/sai, nhất là trên PuTTY/PowerShell
 * khi chuỗi dài bị xuống dòng tự động). An toàn: chỉ thay đúng 1 dòng, giữ nguyên mọi dòng khác.
 */
function saveSessionToEnvFile(sessionString: string): void {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';
  const line = `TELEGRAM_USER_SESSION=${sessionString}`;
  if (/^TELEGRAM_USER_SESSION=.*$/m.test(content)) {
    content = content.replace(/^TELEGRAM_USER_SESSION=.*$/m, line);
  } else {
    content = content.replace(/\n?$/, '\n') + line + '\n';
  }
  fs.writeFileSync(ENV_FILE, content);
}

/**
 * Script chạy TAY, 1 LẦN DUY NHẤT (`npm run telegram:login`) để đăng nhập 1 tài khoản Telegram
 * NGƯỜI THẬT (không phải bot) qua giao thức MTProto — cần thiết vì Bot API không bao giờ thấy
 * được tin nhắn do MỘT BOT KHÁC gửi trong group (xem giải thích đầy đủ trong config.ts). Đăng
 * nhập xong, TỰ ĐỘNG ghi chuỗi session vào file .env (xem `saveSessionToEnvFile`) — không cần tự
 * tay copy/dán gì cả. Từ đó `npm run web` tự kết nối lại bằng chuỗi này, không cần đăng nhập lại.
 */
async function main() {
  if (!config.telegramApiId || !config.telegramApiHash) {
    console.error(
      'Cần đặt TELEGRAM_API_ID và TELEGRAM_API_HASH trong .env trước khi chạy lệnh này.\n' +
        'Lấy 2 giá trị này tại https://my.telegram.org -> đăng nhập bằng SĐT của tài khoản sẽ dùng để theo dõi group -> "API development tools" -> tạo 1 app bất kỳ (tên gì cũng được).',
    );
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), config.telegramApiId, config.telegramApiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('Nhập số điện thoại Telegram (kèm mã quốc gia, vd +84912345678): '),
    password: async () => await input.text('Nhập mật khẩu xác thực 2 bước (để trống nếu tài khoản chưa bật): '),
    phoneCode: async () => await input.text('Nhập mã OTP Telegram vừa gửi về: '),
    onError: (err) => console.error(err),
  });

  const sessionString = String(client.session.save());
  saveSessionToEnvFile(sessionString);
  console.log('\n\n✅ ĐĂNG NHẬP THÀNH CÔNG — đã TỰ ĐỘNG lưu vào file .env (dòng TELEGRAM_USER_SESSION=), không cần làm gì thêm.\n');
  console.log('Lưu ý: tài khoản này PHẢI đã ở trong group Telegram mà bot meetscript.io đang gửi kết quả vào.\n');
  console.log('Tiếp theo chỉ cần chạy: sudo systemctl restart internal-tool-web\n');

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Lỗi khi đăng nhập Telegram:', err);
  process.exit(1);
});
