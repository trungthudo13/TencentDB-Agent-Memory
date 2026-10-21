# Kết nối MemoryKnowledge qua MCP

MemoryKnowledge cung cấp 12 tools truy vấn CodeGraph và Wiki qua **Streamable HTTP**
hoặc **stdio**. Với Docker Compose, Agent kết nối trực tiếp tới
`http://127.0.0.1:8421/mcp`; endpoint này chạy cùng Knowledge API, không cần
container MCP hay cổng riêng. Đây là MCP của Knowledge, chưa phải MCP cho
Memory Commands (`mem:sync`, `mem:create-task`…) hoặc memagent.

## Chạy với Docker Compose

Từ thư mục gốc repository, giữ lại `docker/.env` hiện có và kiểm tra các giá trị:

```dotenv
KNOWLEDGE_PORT=8421
KNOWLEDGE_MCP_ENABLED=true
KNOWLEDGE_MCP_ALLOWED_ORIGINS=
KNOWLEDGE_SERVICE_KEY=
```

`KNOWLEDGE_SERVICE_KEY` để trống chỉ phù hợp với môi trường local tin cậy.
Nếu dùng chung hoặc mở truy cập từ máy khác, đặt service key và dùng HTTPS qua
reverse proxy. Compose mặc định bind vào `127.0.0.1`. Khi kết nối từ xa, thay
host trong URL bằng địa chỉ server Agent truy cập được và cấu hình binding phù hợp.

```bash
docker compose -f docker/docker-compose.yml config --quiet
docker compose -f docker/docker-compose.yml up -d --build knowledgebase
curl -fsS http://127.0.0.1:8421/health
```

Sau khi đổi `.env`, dùng `up -d knowledgebase` để áp dụng environment mới;
`restart` không cập nhật environment. Nếu đổi source, thêm `--build`.
Đặt `KNOWLEDGE_MCP_ENABLED=false` để tắt `/mcp` mà vẫn giữ Knowledge API.

## Cấu hình MCP client

Chọn transport **Streamable HTTP** và nhập các giá trị dưới đây vào cấu hình
MCP của ứng dụng Agent. Tên trường/cú pháp file phụ thuộc client:

| Trường | Giá trị |
| --- | --- |
| URL | `http://127.0.0.1:8421/mcp` |
| Header `x-tdai-service-id` | `default`, hoặc service ID đang chứa tài sản của bạn |
| Header `Authorization` | `Bearer <KNOWLEDGE_SERVICE_KEY>` nếu server đã cấu hình key |

Gửi các header trên **mọi request MCP**, kể cả `initialize` và `tools/list`.
Server yêu cầu service ID cho mọi POST; GET/DELETE chỉ kiểm tra Origin và xác
thực trước khi trả 405.
URL MCP là `/mcp`, không phải `/v3/mcp` hay `/v3/tools/call`. Nếu Agent chạy
trong cùng Docker network, URL là `http://knowledgebase:8421/mcp`.

Service key là thông tin xác thực nội bộ của Knowledge, **không phải Memory
user key, token đăng nhập model hay OAuth**. `x-tdai-service-id` chọn tenant
trong phạm vi service key dùng chung; server không xác minh quyền từng user
hoặc giới hạn key vào một service ID. Chỉ cấp key này cho client tin cậy.

Nếu client gửi header `Origin`, server chỉ chấp nhận origin khớp chính xác
trong `KNOWLEDGE_MCP_ALLOWED_ORIGINS`, ví dụ:

```dotenv
KNOWLEDGE_MCP_ALLOWED_ORIGINS=https://agent.example.com,http://localhost:3000
```

Không dùng wildcard. Mặc định danh sách rỗng từ chối mọi request có `Origin`.
Native MCP client không gửi `Origin` vẫn được chấp nhận, nhưng vẫn cần các
header service ID và xác thực ở trên. Allowlist chỉ kiểm tra giá trị `Origin`;
server chưa cung cấp CORS/OPTIONS cho truy cập trực tiếp từ JavaScript trong
trình duyệt. Thêm origin vào danh sách không tự bật browser CORS.

## Kiểm tra kết nối và gọi tools

Kết nối bằng MCP client rồi chạy thao tác liệt kê tools. Kết quả gồm:

| Nhóm | Tools |
| --- | --- |
| CodeGraph | `code_search`, `code_explore`, `code_callers`, `code_callees`, `code_impact`, `code_node`, `code_status`, `code_files` |
| Wiki | `wiki_search`, `wiki_read`, `wiki_list`, `wiki_graph` |

Đăng ký repository hoặc Wiki và đồng bộ dữ liệu qua Panel/API trước khi truy
vấn. Với CodeGraph, đợi tài sản có trạng thái `ready`. Cung cấp đúng ID cho
Agent, ví dụ:

> Dùng code_status kiểm tra CodeGraph có ID `<code_graph_id>`, sau đó dùng
> code_search tìm hàm xử lý authentication và code_callers xem nơi gọi.

Tools nhận `code_graph_id` hoặc `wiki_id` theo schema mà client khám phá qua
`tools/list`. MCP không tự chọn Team/Agent/session của MemoryProxy và không tự
đăng ký repository hay index dữ liệu.

Có thể kiểm tra bước bắt tay bằng Bash/curl. Nếu server có key, đặt biến
`KNOWLEDGE_SERVICE_KEY` trong shell trước khi chạy (không ghi key vào tài liệu):

```bash
mcp_headers=(-H 'Content-Type: application/json'
  -H 'Accept: application/json, text/event-stream'
  -H 'x-tdai-service-id: default')
if [ -n "${KNOWLEDGE_SERVICE_KEY:-}" ]; then
  mcp_headers+=(-H "Authorization: Bearer ${KNOWLEDGE_SERVICE_KEY}")
fi
curl -sS http://127.0.0.1:8421/mcp "${mcp_headers[@]}" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"manual-check","version":"1.0"}}}'
```

Phản hồi JSON có `result.protocolVersion`, `result.capabilities` và
`result.serverInfo`. Health check chỉ chứng minh tiến trình đang chạy; cần
kết nối MCP và gọi tool với tài sản thật để kiểm tra dữ liệu.

## Giới hạn transport

Endpoint dùng Streamable HTTP **stateless**, trả kết quả JSON cho request POST.
Không tạo session phía server; không hỗ trợ SSE notifications, resume hay
server-initiated requests. GET và DELETE trả `405 Method Not Allowed` sau khi
qua kiểm tra truy cập. Client phải hỗ trợ Streamable HTTP; client chỉ hỗ trợ
transport HTTP+SSE cũ cần dùng stdio hoặc được nâng cấp.

## Stdio khi chạy client trên máy local

Cần Node.js 22 trở lên và Knowledge HTTP API đang chạy. Build từ source:

```bash
cd MemoryKnowledge
npm install --no-audit --no-fund
npm run build
```

Cấu hình ứng dụng Agent để tự khởi chạy tiến trình với các trường:

| Trường | Giá trị |
| --- | --- |
| Command | Đường dẫn tới executable `node` |
| Arguments | Đường dẫn tuyệt đối tới `MemoryKnowledge/dist/mcp/server.mjs` |
| Environment `KNOWLEDGE_API_URL` | `http://127.0.0.1:8421` (không thêm `/mcp` hoặc `/v3`) |
| Environment `KNOWLEDGE_API_PREFIX` | Tùy chọn, mặc định `/v3`; khớp `API_PREFIX` của Knowledge API |
| Environment `KNOWLEDGE_SERVICE_ID` | `default`, hoặc service ID chứa tài sản |
| Environment `KNOWLEDGE_API_TOKEN` | Giá trị service key nếu đã cấu hình |

Đây là tiến trình stdio do client quản lý, không cần mở terminal chạy thường trực.
Stdio chuyển tool call sang Knowledge HTTP API. Tắt `KNOWLEDGE_MCP_ENABLED`
chỉ tắt transport HTTP `/mcp`, không tắt adapter stdio.

## Xử lý lỗi

| Hiện tượng | Kiểm tra |
| --- | --- |
| `404` tại `/mcp` | Đúng URL root `/mcp`, đã rebuild image mới và `KNOWLEDGE_MCP_ENABLED=true`. |
| `401` | Gửi đúng Bearer service key trên mọi request; không dùng Memory user key. |
| `400` thiếu service ID | Thêm `x-tdai-service-id` vào mọi request. |
| `403` khi có Origin | Thêm đúng origin của client vào allowlist, rồi recreate container. |
| `405` khi mở URL bằng trình duyệt | GET không mở trang MCP; dùng client Streamable HTTP gửi POST. |
| Tool báo không tìm thấy tài sản | Kiểm tra service ID, ID tài sản và trạng thái index trên Panel. |
| `Connection refused` | Kiểm tra cổng, binding và network từ máy/container chạy Agent. |

```bash
docker compose -f docker/docker-compose.yml logs --tail=100 knowledgebase
```
