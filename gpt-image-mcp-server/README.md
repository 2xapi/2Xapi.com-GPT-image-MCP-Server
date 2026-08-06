# GPT-image MCP Server (npm)

把 OpenAI 兼容的文生图接口封装成 MCP 工具。接入 Claude Code / Codex / Cursor 等客户端后，对话里说「画一只柴犬」就能出图。

## 一键安装

前提：Node.js 18+（`node -v` 查看）。

### Claude Code

```bash
claude mcp add -s user gpt-image --env IMAGE_API_KEY=你的key -- npx -y gpt-image-mcp-server
```

### Codex

```bash
codex mcp add GPT-image --env IMAGE_API_KEY=你的key -- npx -y gpt-image-mcp-server
```

### Claude Desktop / Cursor（手动配置）

```json
{
  "mcpServers": {
    "GPT-image": {
      "command": "npx",
      "args": ["-y", "gpt-image-mcp-server"],
      "env": {
        "IMAGE_API_KEY": "你的key"
      }
    }
  }
}
```

## 环境变量

| 变量 | 作用 | 必填 |
| --- | --- | --- |
| `IMAGE_API_KEY` | 你自己的 API Key（计费到你的账号） | ✅ |
| `IMAGE_API_BASE_URL` | 覆盖接口根地址（到 `/v1`）；默认用内置端点 | 按需 |
| `IMAGE_CONFIG_PATH` | 覆盖配置文件的保存路径（默认 `~/.gpt-image-mcp/config.json`） | 按需 |

> key 与端点必须配套：你的 key 是哪家供应商的，端点就填哪家的。

## 工具

- `generate_image` — 文生图，返回图片 URL（可自动存本地）
- `get_config` — 查看当前配置（key 自动打码）
- `set_config` — 对话里改端点 / key / 模型 / 尺寸，立即生效
- `set_moderation` — 配置 AI 审核闸门（可选，fail-open）
- `list_image_models` — 列出后端可用模型
