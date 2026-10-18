// Gói "input" (dùng trong telegram-login.ts để hỏi SĐT/mã OTP qua dòng lệnh) không có sẵn file
// khai báo kiểu — chỉ khai báo đúng phần đang dùng (`text`), không cần khai báo đầy đủ cả gói.
declare module 'input' {
  interface TextOptions {
    default?: string;
  }
  function text(message: string, options?: TextOptions): Promise<string>;
  const _default: { text: typeof text };
  export default _default;
}
