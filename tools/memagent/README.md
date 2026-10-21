# memagent

CLI Python để cấu hình Codex hoặc Claude Code kết nối MemoryProxy.
Yêu cầu Python >= 3.10.

Sau khi bản phát hành đã có trên PyPI:

```bash
pip install memagent
memagent init --platform codex --user-key 'sk-mem-...' --agent-id 'agt-...' --team-id 'team-...'
```

Cài từ source trong repository:

```bash
python3 -m venv .venv
.venv/bin/pip install -e tools/memagent

.venv/bin/memagent init --platform codex \
  --user-key 'sk-mem-...' --agent-id 'agt-...' --team-id 'team-...'

.venv/bin/memagent init --platform claude \
  --user-key 'sk-mem-...' --agent-id 'agt-...' --team-id 'team-...'
```

Cũng hỗ trợ `--user_key`, `--agent_id`, `--team_id` và chạy bằng
`.venv/bin/python tools/memagent init ...`.

| Tham số | Mặc định / ý nghĩa |
| --- | --- |
| `--platform` | Bắt buộc: `codex` hoặc `claude` |
| `--user-key` | Bắt buộc: Memory Hub user key |
| `--agent-id`, `--team-id` | Bắt buộc: ID agent và team tương ứng |
| `--proxy-url` | `http://127.0.0.1:8096`, URL gốc của proxy |
| `--service-id` | `default`, memory instance ID |
| `--home` | Home của người dùng; thư mục chứa `.codex` hoặc `.claude` |

Mặc định ghi `~/.codex/config.toml` hoặc `~/.claude/settings.json`.
Dùng `--home .` để ghi vào thư mục hiện tại. Công cụ giữ các cấu hình khác
(model, permissions, MCP, hooks), giữ comment TOML và tạo bản sao
`config.toml.bak-*` hoặc `settings.json.bak-*` trước mỗi thay đổi.
Chạy lại cùng tham số không tạo thêm backup. File sai định dạng không bị ghi đè.

Key được lưu trực tiếp trong cấu hình, file mới và backup có quyền `0600` trên
POSIX. Không commit các file chứa key. CLI không in key, nhưng truyền key trực
tiếp trên command line có thể lưu vào shell history.

Codex dùng provider `memory_proxy`, API Responses và header `x-tdai-user-key`
riêng, giữ xác thực OpenAI hiện có. Claude dùng `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN` cùng `ANTHROPIC_CUSTOM_HEADERS`; proxy cần cấu hình
upstream Claude phù hợp. Cả hai gửi `x-team-id` và `x-agent-id`.

Lệnh chỉ cấu hình client, không khởi chạy server hay xác minh key/ID qua mạng.
MemoryProxy phải đang chạy và bật session initialization, capture/injection
theo nhu cầu. Mở phiên agent mới sau khi init. Tham khảo
[Codex trong repo](../../agents/codex/README.md),
[Claude trong repo](../../agents/claude-code/README.md),
[OpenAI provider settings](https://learn.chatgpt.com/docs/config-file/config-reference)
và [Claude environment variables](https://code.claude.com/docs/en/env-vars).

Chạy kiểm tra:

```bash
.venv/bin/python -m unittest discover -s tools/memagent/tests -v
```
