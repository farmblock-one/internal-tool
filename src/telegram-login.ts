import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import input from 'input';
import { config } from './config.js';

/**
 * Script chạy TAY, 1 LẦN DUY NHẤT (`npm run telegram:login`) để đăng nhập 1 tài khoản Telegram
 * NGƯỜI THẬT (không phải bot) qua giao thức MTProto — cần thiết vì Bot API không bao giờ thấy
 * được tin nhắn do MỘT BOT KHÁC gửi trong group (xem giải thích đầy đủ trong config.ts). Đăng
 * nhập xong, copy chuỗi session in ra dán vào `.env` (TELEGRAM_USER_SESSION) — từ đó
 * `npm run web` tự kết nối lại bằng chuỗi này, không cần đăng nhập tay lần nào nữa.
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
  console.log('\n\n✅ ĐĂNG NHẬP THÀNH CÔNG!\n');
  console.log('Copy TOÀN BỘ chuỗi dưới đây (1 dòng), dán vào file .env ở dòng TELEGRAM_USER_SESSION=\n');
  console.log(sessionString);
  console.log('\nLưu ý: tài khoản này PHẢI đã ở trong group Telegram mà bot meetscript.io đang gửi kết quả vào.\n');

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Lỗi khi đăng nhập Telegram:', err);
  process.exit(1);
});
