# 2Xapi.com GPT-image MCP Server

把 OpenAI 兼容的文生图/图生图接口封装成 MCP 工具。接入 Claude Code / Codex / Cursor / Claude Desktop 等客户端后，**对话里说「画一只柴犬」就能出图，发一张图说「改成动漫风」就能改图**。每位用户使用**自己的 API Key**，消耗计费到各自账号。

## 效果演示

左：`generate_image` 文生图（「一只可爱的橘猫，坐在窗台上，简单插画风格」）；中/右：对左图用 `edit_image` 图生图改风格（全部为真实调用输出）。

| 文生图 | 图生图 · 改水彩风 + 樱花 | 图生图 · 改水墨风 |
| :---: | :---: | :---: |
| ![文生图示例](docs/images/example-generate.png) | ![图生图水彩示例](docs/images/example-edit-watercolor.png) | ![图生图水墨示例](docs/images/example-edit-inkwash.png) |

## 核心功能

- 🎨 **文生图** `generate_image`：文字描述生成图片，返回图片 URL + 结构化结果
- ✏️ **图生图** `edit_image`：传 1-10 张图 + 文字指令，改风格 / 合成 / 扩图（走 `/images/edits`，multipart 上传）
- 🖼 **mask 局部重绘**：可选 mask 图（alpha 通道 PNG，透明区域=重绘区），只改指定区域
- 📥 **四种图片输入**：本地文件路径 / http(s) URL / `data:` URI / 裸 base64（URL 自动下载再上传）
- 🛡 **输入安全校验**：单文件 ≤50MB；本地路径白名单（`IMAGE_ALLOWED_ROOTS`，默认仅主目录）；npm 版用 sharp 校验真实格式（扩展名不符自动纠正），超 4MB 或 1024px 自动压缩后上传
- 🔐 **API Key 脱敏**：错误信息里的 key 自动打码；配置查看时只显示掩码
- 🚦 **AI 审核闸门**（可选）：提示词先过审核模型再进生图账号，减少风控/封号（fail-open，审核服务不可达时自动放行）
- ⚙️ **对话内配置**：`set_config` / `set_moderation` 改端点、key、模型、尺寸，立即生效，无需重启
- 📊 **结构化结果**：`structuredContent` 返回文件路径 + `file://` URI + usage 用量（`include_preview=true` 可选附加内联 JPEG 预览；默认关闭，避免部分 Responses 流式客户端报错）

## 使用方法

接入客户端后，直接用自然语言对话即可，AI 会自动选工具：

| 你说 | 调用 |
| --- | --- |
| 「画一只柴犬，竖图」 | `generate_image(prompt=..., size="1024x1536")` |
| 「画 3 张星空壁纸」 | `generate_image(prompt=..., n=3)` |
| 「把这张图改成动漫风」（发图或给路径） | `edit_image(images=["/path/to/photo.jpg"], prompt="改成动漫风")` |
| 「把这两张图合成一张」 | `edit_image(images=["a.png", "b.png"], prompt="合成一张")` |
| 「只重绘帽子区域」（提供 mask 图） | `edit_image(images=["a.png"], prompt="换一顶帽子", mask="mask.png")` |
| 「查看当前配置」 | `get_config()` |
| 「模型换成 dall-e-3」 | `set_config(model="dall-e-3")` |
| 「更新 key 为 sk-yyy」 | `set_config(api_key="sk-yyy")` |
| 「列出后端有哪些模型」 | `list_image_models()` |

> mask 说明：alpha 通道 PNG，**透明区域 = 重绘区**，不透明 = 保留；需后端支持（2xapi.com 中转站已验证支持）。

## 一键安装（npm 版，推荐）

前提：Node.js 18+。发布到 GitHub Releases 后：

### Claude Code

```bash
claude mcp add -s user gpt-image \
  --env IMAGE_API_KEY=你的key \
  -- npx -y https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.3.1/gpt-image-mcp-server-0.3.1.tgz
```

### Codex

```bash
codex mcp add GPT-image \
  --env IMAGE_API_KEY=你的key \
  -- npx -y https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.3.1/gpt-image-mcp-server-0.3.1.tgz
```

### Claude Desktop / Cursor（手动配置）

```json
{
  "mcpServers": {
    "GPT-image": {
      "command": "npx",
      "args": ["-y", "https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.3.1/gpt-image-mcp-server-0.3.1.tgz"],
      "env": {
        "IMAGE_API_KEY": "你的key"
      }
    }
  }
}
```

- 🤖 **AI 一键部署**：把仓库地址发给任何 AI（Codex / Claude），它会读 `AGENTS.md` 自动完成部署
- ⚡ **一键脚本**（二选一）：
  - `./install.sh`（需先发布 GitHub Release）：`IMAGE_API_KEY=你的key ./install.sh`，自动检测 claude/codex 并接入
  - `./deploy.sh`（本地构建，不依赖 Release）：`./deploy.sh --client codex --key 你的key`
- 📄 部署文档：`GPT-image MCP Server部署文档.md`（约 5 分钟，含给 AI 的提示词模板）
- 🐍 Python 版：`src/`（手动部署用，支持 `uvx` / `uv run`，零额外依赖；预览功能需另装 Pillow）
- ⚡ npm 版：`gpt-image-mcp-server/`（一键安装，推荐）

## 环境变量

| 变量 | 作用 | 必填 |
| --- | --- | --- |
| `IMAGE_API_KEY` | 你自己的 API Key（计费到你的账号） | ✅ |
| `IMAGE_API_BASE_URL` | 覆盖接口根地址（到 `/v1`）；默认用内置端点 | 按需 |
| `IMAGE_CONFIG_PATH` | 覆盖配置文件保存路径（默认 `~/.gpt-image-mcp/config.json`） | 按需 |
| `IMAGE_ALLOWED_ROOTS` | 允许读取的本地图片路径白名单（`:` 分隔，默认仅主目录）；本地路径输入必须落在白名单内 | 按需 |

> key 与端点必须配套：你的 key 是哪家供应商的，端点就填哪家的。

### 默认端点说明

- 本项目默认端点：**`https://2xa.cc.cd/v1`** —— 这是 **2xapi.com 中转站**的 OpenAI 兼容生图接口（官网 <https://2Xapi.com>），本 MCP 默认配套的就是这个方案。
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

## 目录结构

```
.
├── docs/images/                      ← README 演示配图
├── GPT-image MCP Server部署文档.md   ← 部署文档（必读）
├── gpt-image-mcp-server/            ← npm 版（TypeScript，一键安装）
├── src/                             ← Python 版（uvx/uv run）
├── pyproject.toml / uv.lock
└── LICENSE
```

## 安全

- `config.json` 含真实 API Key，已被 `.gitignore` 排除，**不要提交、不要外发**。
- 分发代码前删除 `config.json`；只保留 `config.example.json` 模板。
