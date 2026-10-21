# CI/CD

CLI `memagent` không được build hoặc publish tự động trong GitHub Actions.

## Main pipeline

`main-ci-cd.yml` chạy khi push vào `main`, hoặc chạy thủ công từ Actions trên
nhánh `main`. Workflow PR hiện có (`pr-ci.yml`) vẫn hoạt động riêng.

## CI

- Node.js 22 / npm 11: build MemoryCore, MemoryKnowledge, MemoryPanel backend và
  web, SDK TypeScript; typecheck MemoryProxy (chạy TypeScript trực tiếp bằng tsx);
  chạy tests MemoryAcp (JavaScript, không cần transpile).
- Python 3.11: build wheel/sdist cho SDK Python,
  kiểm tra cài đặt wheel. Artifact `python-packages` giữ 7 ngày.
- Build 5 Docker images từ các Dockerfile/context giống `docker/docker-compose.yml`,
  bao gồm đầy đủ Panel UI, kiến trúc `linux/amd64`. BuildKit cache theo service.
- Image được chuyển qua artifact giữ 1 ngày. CD publish chính image đã build,
  không build lại. Chỉ chạy CD khi tất cả các job CI thành công.

Core không có npm lockfile và có optional OpenClaw peers phụ thuộc vào các
workspace package chưa publish. Job build bỏ các peer đó trong checkout tạm,
tương tự Dockerfile hiện có. Những package có lockfile dùng `npm ci`; lockfile
không đồng bộ sẽ làm CI thất bại thay vì tự sửa.

## GHCR

Workflow dùng `GITHUB_TOKEN` có quyền `packages: write`; không cần thêm PAT hoặc
Docker Hub secret. Repository/organization phải cho phép Actions tạo package.
Với package đã tồn tại, cấp repository quyền Actions write trong Package settings.

Images được đặt dưới tên repository (chuyển thành chữ thường):

```text
ghcr.io/<owner>/<repository>/memory-core
ghcr.io/<owner>/<repository>/memory-proxy
ghcr.io/<owner>/<repository>/memory-knowledge
ghcr.io/<owner>/<repository>/memory-panel
ghcr.io/<owner>/<repository>/memory-acp
```

Mỗi image có tag `sha-<full-commit-sha>`, `main` và `latest`. Job publish đẩy đủ
5 tag SHA trước khi cập nhật các tag di động. Các lần chạy được tuần tự hóa;
GitHub có thể gộp các lần chạy đang chờ nếu push liên tục. Registry không hỗ trợ
transaction cho cả 5 images: nếu cập nhật tag di động bị lỗi giữa chừng, dùng
cùng một tag SHA cho cả stack rồi chạy lại workflow.

GHCR tạo package mới ở chế độ **private**, kể cả repository public. Sau lần
publish đầu, mở từng package → **Package settings → Change visibility → Public**
nếu muốn pull không cần đăng nhập. Đây là thiết lập một lần, workflow không đổi
visibility. Xem [GitHub Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Ví dụ:

```bash
docker pull ghcr.io/<owner>/<repository>/memory-core:latest
```

CD ở đây là publish lên registry; không restart hay deploy lên máy chủ.
MongoDB dùng image upstream và không được build/publish lại. SDK Python
được build thành package artifacts, không có service Docker riêng. Các Dockerfile
gộp service trong `deploy/` là cách đóng gói thay thế, không nằm trong workflow này.

Các bước build/test không cần LLM credentials. Workflow không chạy integration
tests cần database/LLM bên ngoài; build thành công không thay thế kiểm tra runtime
toàn stack với cấu hình production.
