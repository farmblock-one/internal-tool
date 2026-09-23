# internal-tool — Apollo → Debounce → Drive automation

Playwright automation cho luồng: export leads từ 1 list Apollo.io → lọc email qua Debounce.io
→ import kết quả ngược lại Apollo → tách file Safe to Send / Risky → upload Safe to Send lên
Google Drive.

## ⚠️ Trước khi chạy thật — những phần cần bạn kiểm chứng lại

Mình viết code này mà **không có quyền truy cập tài khoản Apollo/Debounce thật**, nên có 2 chỗ
gần như chắc chắn cần chỉnh tay:

1. **`src/apollo.ts`** — selector các nút "Clear all", "Export", "Export Emails", "Download",
   "Import" dựa trên UI phổ biến của Apollo, có thể lệch với UI thật hiện tại.
2. **`src/debounce.ts`** — endpoint `bulk.debounce.io` và field JSON (`list_id`, `status`,
   `download_url`) dựa trên thông tin tìm được qua search, **chưa xác minh được với tài liệu
   chính thức** (môi trường sandbox lúc viết code này bị chặn truy cập debounce.io/.com).
   Trước khi chạy thật, đối chiếu lại tại https://developers.debounce.com/reference.

Cách sửa khi 1 bước Apollo bị fail: chạy `HEADLESS=false npm run flow -- <url>` hoặc
`PWDEBUG=1 npm run flow -- <url>` để mở Playwright Inspector, dùng "Pick locator" lấy đúng
selector rồi sửa trong `src/apollo.ts`.

## Cài đặt

```bash
npm install
npx playwright install chrome   # cài Google Chrome thật (không phải Chromium bundled)
cp .env.example .env            # rồi điền các giá trị vào .env
```

Điền `.env`:
- `DEBOUNCE_API_KEY` — lấy tại app.debounce.io > Settings > API
- `GOOGLE_SERVICE_ACCOUNT_KEY` — đường dẫn file JSON key (xem hướng dẫn trong `src/drive.ts`)
- `GDRIVE_SAFE_TO_SEND_FOLDER_ID` — ID folder Drive đích

## Đăng nhập Apollo lần đầu (bắt buộc, làm 1 lần)

Server này không có màn hình (headless VM), nên cần 1 trong 2 cách sau để thấy cửa sổ Chrome
và tự bấm đăng nhập:

### Cách A — tạo màn hình ảo tạm thời trên server (khuyến nghị)

```bash
sudo apt install -y xvfb x11vnc novnc websockify
Xvfb :99 -screen 0 1440x900x24 &
export DISPLAY=:99
x11vnc -display :99 -nopw -forever &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 &
```

Sau đó mở trình duyệt trên máy cá nhân tới `http://<IP_SERVER>:6080/vnc.html` để **nhìn thấy**
màn hình ảo của server. Rồi ở 1 cửa sổ SSH khác:

```bash
DISPLAY=:99 npm run apollo:login
```

Bấm đăng nhập Apollo trong cửa sổ Chrome (qua noVNC), xong quay lại terminal SSH, nhấn Enter.
Sau khi xong có thể tắt Xvfb/x11vnc/websockify (không cần chạy nền liên tục, chỉ cần lúc login).

⚠️ Nhớ mở port 6080 trên firewall chỉ tạm thời và đóng lại ngay sau khi login xong — noVNC ở
trên không có mật khẩu, ai biết IP:port cũng xem được màn hình server.

### Cách B — login trên máy cá nhân rồi copy profile lên server

Clone repo này về máy cá nhân (đã có sẵn Chrome), chạy `npm run apollo:login`, đăng nhập bình
thường. Sau đó copy toàn bộ thư mục `.chrome-profile` lên server, đúng đường dẫn khai trong
`CHROME_USER_DATA_DIR` của `.env`.

## Chạy luồng

```bash
npm run flow -- "https://app.apollo.io/?...#/lists/<list_id>"
```

Kết quả các file trung gian được lưu ở `data/downloads/` và `data/processed/`:
- `apollo-export-*.csv` — file thô export từ Apollo
- `debounce-result-*.csv` — sau khi verify qua Debounce (có cột RESULT)
- `apollo-reimport-*.csv` — chỉ 2 cột email + RESULT, đã import ngược lại Apollo
- `safe-to-send-*.csv` — đã upload lên Google Drive
- `risky-*.csv` — chờ xử lý ở bước tiếp theo (luồng nội bộ khác, chưa build trong repo này)

## Chạy nền dài hạn (qua tmux)

```bash
tmux new -s automation
npm run flow -- "<apollo_list_url>"
# Ctrl+B rồi D để detach, không cần giữ SSH mở
```
