# 2Xapi.com GPT-image MCP Server

把 OpenAI 兼容的文生图/图生图接口封装成 MCP 工具。接入 Claude Code / Codex / Cursor / Claude Desktop 等客户端后，**对话里说「画一只柴犬」就能出图，发一张图说「改成动漫风」就能改图**。每位用户使用**自己的 API Key**，消耗计费到各自账号。

- 🤖 **AI 一键部署**：把仓库地址发给任何 AI（Codex / Claude），它会读 `AGENTS.md` 自动完成部署
- ⚡ **一键脚本**（二选一）：
  - `./install.sh`（需先发布 GitHub Release）：`IMAGE_API_KEY=你的key ./install.sh`，自动检测 claude/codex 并接入
  - `./deploy.sh`（本地构建，不依赖 Release）：`./deploy.sh --client codex --key 你的key`
- 📄 部署文档：`GPT-image MCP Server部署文档.md`（约 5 分钟，含给 AI 的提示词模板）
- 🐍 Python 版：`src/`（手动部署用，支持 `uvx` / `uv run`）
- ⚡ npm 版：`gpt-image-mcp-server/`（一键安装，推荐）

## 一键安装（npm 版，推荐）

前提：Node.js 18+。发布到 GitHub Releases 后：

### Claude Code

```bash
claude mcp add -s user gpt-image \
  --env IMAGE_API_KEY=你的key \
  -- npx -y https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.3.0/gpt-image-mcp-server-0.3.0.tgz
```

### Codex

```bash
codex mcp add GPT-image \
  --env IMAGE_API_KEY=你的key \
  -- npx -y https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.3.0/gpt-image-mcp-server-0.3.0.tgz
```

### Claude Desktop / Cursor（手动配置）

```json
{
  "mcpServers": {
    "GPT-image": {
      "command": "npx",
      "args": ["-y", "https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.3.0/gpt-image-mcp-server-0.3.0.tgz"],
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
| `IMAGE_ALLOWED_ROOTS` | 允许读取的本地图片路径白名单（`:` 分隔，默认仅主目录）；本地路径输入必须落在白名单内 | 按需 |

> key 与端点必须配套：你的 key 是哪家供应商的，端点就填哪家的。

### 默认端点说明

- 本项目默认端点：**`https://2xa.cc.cd/v1`** —— 这是 **2xapi.com 中转站**的 OpenAI 兼容生图接口（官网 https://2Xapi.com），本 MCP 默认配套的就是这个方案。
- 使用 **2xapi.com 中转站**的 API Key 可直接运行，**无需配置端点**。
- 如果想使用**其他 API 端点**（OpenAI 官方、Azure、其他中转站等），需要**自己更换**：
  - 一键安装/npx 方式：设置环境变量 `IMAGE_API_BASE_URL=https://你的端点/v1`
  - Python 版：修改 `config.json` 的 `api_base_url` 字段
  - 更换后 key 必须与该端点配套，否则报 401。

## 工具

| 工具 | 作用 |
| --- | --- |
| `generate_image` | 文生图，返回图片 URL（可自动存本地）|
| `edit_image` | 图生图（图文生图）：传 1-10 张图 + 文字指令，改图 / 合成 / 扩图；支持 mask 局部重绘 |
| `get_config` | 查看当前配置（API Key 自动打码）|
| `set_config` | 对话里改端点 / key / 模型 / 尺寸，立即生效 |
| `set_moderation` | 配置 AI 审核闸门（可选，fail-open）|
| `list_image_models` | 列出后端可用模型 |

### 图生图（`edit_image`）用法

把图片给到对话里的 AI（或直接告诉它图片路径），再说要怎么改：

- 「把这张图改成动漫风」→ `edit_image(images=["/path/to/photo.jpg"], prompt="改成动漫风")`
- 「把这两张图合成一张」→ `edit_image(images=["a.png", "b.png"], prompt="合成一张")`
- 「只重绘帽子的区域」→ `edit_image(images=["a.png"], prompt="换一顶帽子", mask="mask.png")`（mask 为 alpha 通道 PNG，透明区域=重绘区，需后端支持）

每张图支持四种输入：**本地文件路径**、**http(s) URL**、`data:` URI、**裸 base64**。走后端的 `/images/edits` 接口（OpenAI 兼容，multipart 上传）。

输入图会做安全校验：**单文件 ≤50MB**、本地路径必须在白名单内；npm 版还会用 sharp 读真实格式（扩展名不符自动纠正），超过 4MB 或 1024px 的图自动压缩后再上传。输出默认带 **512px JPEG 内联预览**（`include_preview=false` 可关，Python 版预览需安装 Pillow），并返回结构化结果（`structuredContent`：文件路径 + `file://` URI）。

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
