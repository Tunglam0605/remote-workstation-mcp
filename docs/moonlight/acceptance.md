# Moonlight — bản tích hợp local để nghiệm thu

Preview tích hợp: http://127.0.0.1:4174/

Bản thiết kế đã duyệt giữ nguyên ở http://127.0.0.1:4173/.

## Phạm vi đã hoàn thành

Giao diện Moonlight được phục vụ từ Control Center HTTP server, dùng API và dữ liệu thật. Giữ vanilla HTML/CSS/JS, thêm API client, store, mô hình dữ liệu và các view chức năng. Toàn bộ CSS nền gốc và artwork Trung Thu có SHA-256 giống bản đã duyệt. Sửa tiếng Việt UTF-8; token chỉ ở trang khởi tạo và bộ nhớ, meta được gỡ sau khi đọc.

| Thành phần | Nguồn và hành vi |
|---|---|
| Overview / host / System Health | `/api/status`, `/api/runtime/status`: tên máy, phiên bản, runtime, tunnel, auth, health thật |
| Codex / Antigravity | `/api/execution-policy`, `/api/antigravity/status`: cấu hình, đăng nhập, khả năng sử dụng; không suy đoán trạng thái |
| Access / admin | Các owner API permissions, lease, approval/deny; giữ UAC trên Windows |
| Execution Policy | Mode cấu hình/hiệu lực, broker, provider, hạn mức, fallback, overrides |
| Devices / Multi-node | Pairing, thu hồi, bootstrap SSH, cấu hình và grant thật |
| Updates | Updater status/check/config/install và trạng thái transaction thật |
| Settings / Recovery | Lưu cấu hình, bootstrap, test/apply recovery, quản lý key/tunnel; Start/Stop/Restart và startup runtime |
| Notifications / Activities | Tổng hợp sự kiện và trạng thái có thật; không tạo lịch sử giả |
| Execution Console | `/api/execution`: chọn node local, dự án Git được phép, Work Session và thao tác có kiểu; Git status hoặc task profile do owner cấu hình, đọc/dừng tiến trình |

Console thêm một cầu nối hẹp vì owner HTTP API cũ chưa có execution endpoint dùng được từ trình duyệt. Nó tái sử dụng PolicyEngine, PathGuard, GitAdapter, TaskAdapter, ProcessManager, WorkSessionStore và audit/scope hiện có. Không lấy bearer của MCP runtime; không mở arbitrary shell; không gọi createContext hay reconcile production. Direct typed tools giữ nguyên ngữ nghĩa của backend, độc lập với chế độ worker Codex/Antigravity.

## Bằng chứng kiểm tra

- Full `npm test`: **409 tests; 407 pass, 0 fail, 2 skip**. Hai test skip theo môi trường là KiCad symlink-output và systemd.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run plugin:validate`: PASS, v0.30.0.
- `git diff --check`: PASS.
- HTTP tests: thiếu/sai token, origin khác, Host khác, asset ngoài allowlist bị từ chối; CSP chỉ cho script cùng origin.
- Execution tests: node lạ, field chèn thêm, quyền/scope không đủ, read_only, session khác owner/closing/closed/expired, process khác session, cwd ngoài session, profile lạ, giới hạn chạy đồng thời, giữ/thu hồi output có giới hạn.
- Browser fixture: năm view mở được, payload owner action đúng, lỗi được hiển thị, password được xóa, nút khóa trong khi chờ. Mọi thao tác ghi được chặn và trả fixture; không thực hiện update/UAC/restart trên production.
- Browser console fixture: chọn task thứ hai gửi đúng profile; session mới giữ lựa chọn; output cộng dồn qua các lần đọc và sau stop; lỗi được hiển thị.
- Browser với backend thật: đã tạo session owner riêng cho worktree tích hợp và đọc **Git status thật** thành công. Không chạy task profile hoặc lệnh shell trên production.
- So sánh ở **1672×941** và **1920×1080**: mọi hình chữ nhật được đo của topbar, sidebar, hero, hàng thẻ, bốn panel và footer trùng bản :4173. Sáu thẻ hiện tại là host + hai node đã ghép + hai provider + System Health. Không có lỗi JavaScript hay tải tài nguyên.
- Responsive được kiểm tra từ 320 tới 1920 px; ảnh điện thoại 390 px đính kèm.

## Dữ liệu và giới hạn được thể hiện trung thực

- Backend chưa cung cấp CPU/RAM/network telemetry và trạng thái online/health hiện thời của paired node: giao diện không tự điền số hoặc coi paired là online.
- Antigravity hiện trả trạng thái không sẵn sàng; hiển thị Unavailable.
- Policy thực tế chưa có task profile. Git status dùng được; chạy task cần profile do owner cấu hình, không có ô nhập shell tự do.
- Console hiện hỗ trợ node local. Remote execution không được tự chuyển sang SSH.
- Dự án console được phát hiện có giới hạn tại root và các thư mục con Git/worktree trực tiếp trong workspace được phép.
- Lịch sử tổng quát và live worker queue không được backend expose; chỉ có sự kiện admin/updater mà API cung cấp.
- Các tác vụ có ảnh hưởng production đã nối API và kiểm tra bằng fixture; chưa thực hiện thật để tránh thay đổi môi trường đang dùng.

## Cô lập khi kiểm thử

Kiểm thử giao diện và bản đóng gói trong checkout hoặc thư mục tạm riêng. Không dùng bài kiểm thử để thay đổi runtime đang vận hành. Các kết quả trên ghi nhận đợt tích hợp ban đầu trước khi bổ sung song ngữ; kết quả nghiệm thu của bản phát hành được ghi riêng trong ghi chú phát hành.
