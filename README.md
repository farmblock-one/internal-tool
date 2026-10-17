# internal-tool — Apollo → Debounce automation

Playwright automation cho luồng: export leads từ 1 list Apollo.io → bỏ lead có Email Status =
Unavailable → lọc email qua Debounce.io → import kết quả ngược lại Apollo → lưu lại file gốc
(mọi lead + cột RESULT) dạng Excel để chỉnh tay sau này → tách riêng các lead Risky ra 1 file CSV
để xử lý tiếp (luồng Teams/Gmail/meetscript.io).

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
- `GDRIVE_SAFE_TO_SEND_FOLDER_ID` — ID folder Drive đích (dùng ở 1 giai đoạn sau, chưa gọi tới trong luồng chính)
- `WEBUI_PASSWORD` — mật khẩu cho web UI (`npm run web`, xem phần bên dưới) — nên đặt vì VM có IP công khai

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

## Đăng nhập Teams + Gmail cho xử lý Risky (bắt buộc, làm 1 lần)

Bước xử lý tiếp các lead Risky (bắt cURL Teams/Gmail rồi upload lên meetscript.io) dùng 1 Chrome
profile **RIÊNG** với Apollo (`RISKY_CHROME_USER_DATA_DIR` trong `.env`, mặc định
`./.chrome-profile-risky`) — tách biệt để hàng đợi Risky chạy **đồng thời** được với hàng đợi
Apollo/Debounce mà không tranh nhau khoá 1 profile Chrome (2 Chrome mở cùng 1 profile sẽ làm
nhau crash, đã xác nhận thực tế). Vì là profile mới hoàn toàn nên **không có sẵn session Teams/
Gmail** từ profile Apollo cũ — phải đăng nhập lại 1 lần ở đây.

Làm tương tự Cách A/B ở mục đăng nhập Apollo phía trên, chỉ đổi lệnh:

```bash
DISPLAY=:99 npm run risky:login
```

Lệnh này mở sẵn 2 tab (Microsoft Teams + Gmail) — đăng nhập xong cả 2 rồi quay lại terminal, nhấn
Enter để lưu session.

## Chạy luồng (dòng lệnh, qua SSH)

```bash
npm run flow -- "https://app.apollo.io/?...#/lists/<list_id>" "Tên-file-output"
```

Tham số tên file output không bắt buộc (bỏ trống sẽ tự đặt tên theo timestamp).

Kết quả các file trung gian được lưu ở `data/downloads/` và `data/processed/`:
- `apollo-export-*.csv` — file thô export từ Apollo
- `apollo-export-cleaned-*.csv` — đã bỏ lead "Email Status = Unavailable" + 2 cột Contact/Account Owner
- `debounce-result-*.csv` — sau khi verify qua Debounce (có cột RESULT), TẤT CẢ lead
- `apollo-reimport-*.csv` — chỉ 2 cột email + RESULT, đã import ngược lại Apollo
- `<Tên-file-output>.xlsx` — file gốc sau Debounce (mọi lead, mọi cột + RESULT) dạng Excel, để tự chỉnh tay
- `risky-*.csv` — các lead Risky, chờ xử lý tiếp (`npm run risky -- <file>`)

## Chạy nền dài hạn (qua tmux)

```bash
tmux new -s automation
npm run flow -- "<apollo_list_url>" "<tên-file-output>"
# Ctrl+B rồi D để detach, không cần giữ SSH mở
```

## Chạy qua Web UI (khuyến nghị cho cả team dùng)

Thay vì mỗi lần chạy phải SSH vào server và gõ lệnh, `npm run web` mở 1 trang web đơn giản để
nhập link List Apollo + tên file output mong muốn, bấm "Bắt đầu chạy", rồi theo dõi log/tải file
kết quả ngay trên trình duyệt — không cần biết dòng lệnh.

```bash
npm run web
```

Mặc định `WEBUI_HOST=127.0.0.1` — web chỉ nghe trên chính server, chưa truy cập được từ bên ngoài.
Cách khuyến nghị là setup Caddy để có HTTPS thật (xem mục ngay dưới) rồi truy cập qua
`https://<domain>/`. Nhớ:
- **Đặt `WEBUI_PASSWORD` trong `.env` trước khi chạy** — không đặt mật khẩu thì bất kỳ ai vào được
  trang cũng chạy được luồng (tốn tiền Apollo/Debounce thật). Trình duyệt sẽ tự hỏi mật khẩu 1 lần
  (không cần tên đăng nhập, để trống hoặc gõ gì cũng được).
- Có **2 hàng đợi độc lập**, mỗi hàng đợi dùng 1 Chrome profile riêng nên chạy **đồng thời** được
  với nhau (nhưng trong CÙNG 1 hàng đợi vẫn chỉ chạy 1 job tại 1 thời điểm, xếp hàng lần lượt —
  chạy 2 job chung 1 profile Chrome sẽ làm nhau crash):
  - Hàng đợi **Apollo/Debounce** (profile `CHROME_USER_DATA_DIR`).
  - Hàng đợi **Risky** (Teams/Gmail &rarr; meetscript.io, profile `RISKY_CHROME_USER_DATA_DIR`) —
    tự động được đẩy vào ngay khi job Apollo/Debounce tương ứng chạy xong (không cần bấm nút gì
    thêm), và **không chặn** job Apollo/Debounce mới của người khác nữa dù list lớn có thể mất
    hàng giờ để xử lý xong Risky.
- Nếu 1 list Risky bị tách thành nhiều phần (>1000 lead, giới hạn của meetscript.io), các phần
  được upload **song song** (tối đa `RISKY_CONCURRENCY` lượt cùng lúc, mặc định 5) thay vì lần
  lượt — trang trạng thái của job Risky hiển thị tiến trình kiểu "12/60 lượt" theo thời gian thực.
- Danh sách job hiện chỉ lưu trong bộ nhớ — tắt/khởi động lại server sẽ mất lịch sử hiển thị trên
  web (các file kết quả trên đĩa thì KHÔNG mất, vẫn nằm trong `data/processed/`).

### HTTPS thật qua Caddy (khuyến nghị)

Trình duyệt luôn cảnh báo "Your connection to this site is not private" khi nhập mật khẩu qua
`http://` (không mã hoá) — Caddy là 1 reverse proxy tự động xin + tự gia hạn chứng chỉ HTTPS miễn
phí (Let's Encrypt), đứng trước web UI để xử lý phần này, gần như không cần cấu hình tay.

Dùng được ngay tên miền đã có sẵn trong `.env` (`PUBLIC_HOST`, vd `103-252-122-224.sslip.io` —
dịch vụ sslip.io tự trỏ tên miền về đúng IP của bạn, dùng được với Let's Encrypt như tên miền thật).

```bash
# 1. Cài Caddy (1 lần)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy

# 2. Cấu hình Caddy trỏ về web UI chạy ở localhost:8090
# (thay 103-252-122-224.sslip.io bằng đúng giá trị PUBLIC_HOST trong .env của bạn)
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
103-252-122-224.sslip.io {
    reverse_proxy localhost:8090
}
EOF
sudo systemctl reload caddy

# 3. Mở đúng 2 port Caddy cần (80 để xin chứng chỉ, 443 để phục vụ HTTPS) — KHÔNG mở port 8090
sudo ufw allow 80
sudo ufw allow 443
sudo ufw delete allow 8090   # nếu trước đó đã lỡ mở
```

Sau đó truy cập `https://103-252-122-224.sslip.io/` (thay đúng domain của bạn) — Caddy tự xin
chứng chỉ trong vài giây, không còn cảnh báo "not private" nữa. `WEBUI_HOST=127.0.0.1` giữ
nguyên — web UI giờ chỉ nhận request từ Caddy trên chính máy, không lộ trực tiếp ra ngoài.

### Chạy nền vĩnh viễn qua systemd (để team dùng được bất cứ lúc nào, không cần bạn giữ SSH mở)

```bash
sudo tee /etc/systemd/system/internal-tool-web.service > /dev/null <<'EOF'
[Unit]
Description=Internal Tool Web UI
After=network.target

[Service]
Type=simple
User=kai
WorkingDirectory=/home/kai/internal-tool
Environment=DISPLAY=:99
ExecStart=/usr/bin/npx tsx src/server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now internal-tool-web
sudo systemctl status internal-tool-web   # kiểm tra đã chạy chưa
```

Xem log: `sudo journalctl -u internal-tool-web -f`. Sau khi sửa code, deploy file mới xong thì
chạy `sudo systemctl restart internal-tool-web` để áp dụng.

Lưu ý: automation vẫn cần màn hình ảo (Xvfb ở `:99`) đang chạy sẵn như hướng dẫn login phía trên —
service này không tự bật Xvfb.
