# GPT-image MCP Server

把 OpenAI 兼容的文生图接口封装成 MCP 工具。接入 Codex / ZCode / Claude Desktop / Cursor 等客户端后，在对话里说「画一只柴犬」就能直接出图。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `generate_image` | 文生图，返回图片 URL（可自动存本地）|
| `get_config` | 查看当前配置（API Key 自动打码）|
| `set_config` | 对话里改端点 / Key / 模型 / 尺寸，立即生效，不用重启 |
| `set_moderation` | 配置 AI 审核闸门（可选）|
| `list_image_models` | 列出后端可用模型 |

## 快速开始

部署步骤请看 **`GPT-image MCP Server部署文档.md`**（约 5 分钟），要点：

1. 安装 `uv`（Python >= 3.10）
2. 复制 `src/image_mcp_server/config.example.json` 为 `config.json`，填**你自己的** API Key 和端点
3. `uv sync` 安装依赖
4. 在客户端 MCP 配置中注册本 server，重启客户端

## 安全提示

- `config.json` 含真实 API Key，已被 `.gitignore` 排除，**不要提交、不要外发**。
- 分发代码给别人时，请删除 `config.json`（可用下方命令打包）：

```bash
cd ..
zip -r image-mcp-server.zip image-mcp-server \
  -x "image-mcp-server/.venv/*" \
  -x "image-mcp-server/src/image_mcp_server/config.json" \
  -x "*/__pycache__/*"
```
