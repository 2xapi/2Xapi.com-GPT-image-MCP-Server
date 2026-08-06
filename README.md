# 2Xapi.com GPT-image MCP Server

把 OpenAI 兼容的文生图接口封装成 MCP 工具。接入 Claude Code / Codex / Cursor / Claude Desktop 等客户端后，**对话里说「画一只柴犬」就能出图**。每位用户使用**自己的 API Key**，消耗计费到各自账号。

- 🤖 **AI 一键部署**：把仓库地址发给任何 AI（Codex / Claude），它会读 `AGENTS.md` 自动完成部署；或直接跑 `./deploy.sh --client codex --key 你的key`
- 📄 部署文档：`GPT-image MCP Server部署文档.md`（约 5 分钟，含给 AI 的提示词模板）
- 🐍 Python 版：`src/`（手动部署用，支持 `uvx` / `uv run`）
- ⚡ npm 版：`gpt-image-mcp-server/`（一键安装，推荐）

## 一键安装（npm 版，推荐）

前提：Node.js 18+。发布到 GitHub Releases 后：

### Claude Code

```bash
claude mcp add -s user gpt-image \
  --env IMAGE_API_KEY=你的key \
  -- npx -y https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.1.0/gpt-image-mcp-server-0.1.0.tgz
```

### Codex

```bash
codex mcp add GPT-image \
  --env IMAGE_API_KEY=你的key \
  -- npx -y https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.1.0/gpt-image-mcp-server-0.1.0.tgz
```

### Claude Desktop / Cursor（手动配置）

```json
{
  "mcpServers": {
    "GPT-image": {
      "command": "npx",
      "args": ["-y", "https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.1.0/gpt-image-mcp-server-0.1.0.tgz"],
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
| `IMAGE_CONFIG_PATH` | 覆盖配置文件保存路径（默认 `~/.gpt-image-mcp/config.json`） | 按需 |

> key 与端点必须配套：你的 key 是哪家供应商的，端点就填哪家的。

## 工具

| 工具 | 作用 |
| --- | --- |
| `generate_image` | 文生图，返回图片 URL（可自动存本地）|
| `get_config` | 查看当前配置（API Key 自动打码）|
| `set_config` | 对话里改端点 / key / 模型 / 尺寸，立即生效 |
| `set_moderation` | 配置 AI 审核闸门（可选，fail-open）|
| `list_image_models` | 列出后端可用模型 |

## 目录结构

```
.
├── GPT-image MCP Server部署文档.md   ← 部署文档（必读）
├── gpt-image-mcp-server/            ← npm 版（TypeScript，一键安装）
├── src/                             ← Python 版（uvx/uv run）
├── pyproject.toml / uv.lock
└── LICENSE
```

## 安全

- `config.json` 含真实 API Key，已被 `.gitignore` 排除，**不要提交、不要外发**。
- 分发代码前删除 `config.json`；只保留 `config.example.json` 模板。
