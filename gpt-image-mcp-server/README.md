# GPT-image MCP Server (npm)

把 OpenAI 兼容的文生图/图生图接口封装成 MCP 工具。接入 Claude Code / Codex / Cursor 等客户端后，对话里说「画一只柴犬」就能出图，发一张图说「改成动漫风」就能改图。

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
| `IMAGE_ALLOWED_ROOTS` | 允许读取的本地图片路径白名单（`:` 分隔，默认仅主目录） | 按需 |

> key 与端点必须配套：你的 key 是哪家供应商的，端点就填哪家的。

输入图 ≤50MB，本地路径必须在白名单内；sharp 校验真实格式，超 4MB 或 1024px 自动压缩；输出默认带 512px JPEG 内联预览（`include_preview=false` 可关）+ `structuredContent`。

### 默认端点说明

- 本项目默认端点：**`https://2xa.cc.cd/v1`** —— 这是 **2xapi.com 中转站**（官网 https://2Xapi.com）的 OpenAI 兼容生图方案，本 MCP 默认配套的就是这个方案。
- 使用 **2xapi.com 中转站**的 API Key 可直接运行，**无需配置端点**。
- 如果想使用**其他 API 端点**（OpenAI 官方、Azure、其他中转站等），需要**自己更换**：设置环境变量 `IMAGE_API_BASE_URL=https://你的端点/v1`；更换后 key 必须与该端点配套，否则报 401。

## 工具

- `generate_image` — 文生图，返回图片 URL（可自动存本地）
- `edit_image` — 图生图（图文生图）：传 1-10 张图（本地路径 / URL / data URI / base64）+ 文字指令，改图 / 合成 / 扩图；支持 `mask` 局部重绘（alpha 通道 PNG）
- `get_config` — 查看当前配置（key 自动打码）
- `set_config` — 对话里改端点 / key / 模型 / 尺寸，立即生效
- `set_moderation` — 配置 AI 审核闸门（可选，fail-open）
- `list_image_models` — 列出后端可用模型
