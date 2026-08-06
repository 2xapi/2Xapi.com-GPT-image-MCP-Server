# GPT-image MCP Server · 一键部署文档

> **目标**：拿到这份文档 + 项目文件夹，约 5 分钟完成部署。
> **你只需要准备两样东西**：
> 1. 你自己的 API Key（OpenAI 兼容文生图接口的 Bearer Token）
> 2. 一个 MCP 客户端（Codex / ZCode / Claude Desktop / Cursor）
>
> ⚠️ 本文档不含任何真实密钥。**示例端点属于作者账号，部署时请全部换成你自己的**（Key、端点、模型三者必须配套，见第 2 步）。

---

## 它能做什么

一个 MCP 服务器，把 OpenAI 兼容的文生图接口封装成工具。接入客户端后，**对话里说「画一只柴犬」就能出图**。

提供 5 个工具：

| 工具 | 作用 |
| --- | --- |
| `generate_image` | 文生图，返回图片 URL（可自动存本地）|
| `get_config` | 查看当前配置（API Key 自动打码显示）|
| `set_config` | 对话里改端点 / Key / 模型 / 尺寸，改完立即生效，**不用重启** |
| `set_moderation` | 配置 AI 审核闸门（可选，见「AI 审核」）|
| `list_image_models` | 列出后端可用模型 |

> **AI 审核（可选）**：开启后，每个提示词在进入生图账号前会先调用一个审核模型，审核不通过直接拒绝，减少违规提示词触发风控/封号。默认关闭；审核服务连不上时自动放行（fail-open），不影响出图。

---

## 第 1 步：确认环境

```bash
python3 --version    # 需要 >= 3.10
uv --version         # 需要 uv，没有就装：见下方
```

安装 uv（如已装可跳过）：

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

> 中国大陆网络下若 `uv sync` 拉 PyPI 超时，换源：
> ```bash
> uv sync --index-url https://pypi.tuna.tsinghua.edu.cn/simple
> ```


## 快速开始（推荐）：npm 一条命令安装，不用下载代码

> 适合已发布到 GitHub Releases 后的版本。前提：**Node.js 18+**（`node -v` 查看；没有就装 Node.js）。
> 你只需要自己的 API Key，**不需要** clone 代码、装 Python/uv、建 config.json、填绝对路径。
> 下面的命令已内置发布地址，直接把 `你的key` 换成你自己的即可。

### Claude Code（一行命令）

```bash
claude mcp add -s user gpt-image --env IMAGE_API_KEY=你的key -- npx -y https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.1.0/gpt-image-mcp-server-0.1.0.tgz
```

### Codex（一行命令）

```bash
codex mcp add GPT-image --env IMAGE_API_KEY=你的key -- npx -y https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.1.0/gpt-image-mcp-server-0.1.0.tgz
```

### Claude Desktop / Cursor（手动配置）

在客户端 MCP 配置里新增（Claude Desktop 用顶层 `mcpServers`，Cursor 按对应文档）：

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

### 环境变量说明

| 环境变量 | 作用 | 必填 |
| --- | --- | --- |
| `IMAGE_API_KEY` | **你自己的** API Key（计费到你的账号） | ✅ |
| `IMAGE_API_BASE_URL` | 覆盖接口根地址（到 `/v1`）。不填则用包内置默认端点 | 按需 |
| `IMAGE_CONFIG_PATH` | 覆盖配置文件保存路径（默认 `~/.gpt-image-mcp/config.json`） | 按需 |

> 默认端点由分发者内置（作者账号的供应商）。**你的 key 是哪家的，就确保端点是哪家的**；key 与端点不配套会 401。
>
> 升级版本：更新 GitHub Release 里的 tgz（版本号变化时同步改 URL 中的 `v0.1.0` 和文件名）。

---

## 传统方式：手动下载代码部署

> 没发布包索引、或想自己改代码时用这个方式，往下走：

## 第 2 步：获取代码

**方式 A**：有仓库地址时用 git 克隆：

```bash
git clone <仓库地址> image-mcp-server
cd image-mcp-server
```

**方式 B**：别人直接发给你整个项目文件夹 / zip，解压后确认目录里有 `pyproject.toml` 和 `src/`，然后 `cd image-mcp-server`。

目录结构：

```
image-mcp-server/
├── README.md
├── pyproject.toml
├── GPT-image MCP Server部署文档.md   ← 本文档
├── .gitignore
└── src/image_mcp_server/
    ├── __init__.py
    ├── server.py
    ├── config.example.json            ← 配置模板（无密钥，可直接复制使用）
    └── config.json                    ← 你的配置（含密钥，由你自己创建，勿外传）
```

> 📦 **给分发者**：打包给别人前，**必须删除 `config.json`**（里面是真实 Key），并排除 `.venv`。可直接用：
> ```bash
> cd ..
> zip -r image-mcp-server.zip image-mcp-server \
>   -x "image-mcp-server/.venv/*" \
>   -x "image-mcp-server/src/image_mcp_server/config.json" \
>   -x "*/__pycache__/*"
> ```

---

## 第 3 步：准备你自己的 API Key（关键）

你需要**自备**一个 OpenAI 兼容图像 API 的 Bearer Token（本文档不提供任何密钥）。从你的供应商处拿到：

1. **API Key**，形如 `sk-xxxxxxxxxxxxxxxx`
2. **接口根地址**（到你供应商的 `/v1` 这一级），形如 `https://your-provider.com/v1`
3. **可用模型 id**，如 `gpt-image-2`、`dall-e-3`

> ⚠️ **Key、端点、模型必须来自同一家供应商**：你的 Key 是哪家的，端点就填哪家的；不要照抄本文档示例里的端点，否则一定报 401。

先验证 key 可用（把 `<...>` 换成你的值）：

```bash
curl -s <你的接口根地址>/models \
  -H "Authorization: Bearer <你的KEY>" \
  -H "User-Agent: Mozilla/5.0"
```

返回含 `data` 数组的 JSON 即正常；返回 401 说明 Key 或端点不对。

---

## 第 4 步：写入你的配置（二选一）

**方式 A（推荐）**：复制模板并填写：

```bash
cp src/image_mcp_server/config.example.json src/image_mcp_server/config.json
```

然后编辑 `src/image_mcp_server/config.json`，**只改 `api_base_url` 和 `api_key`（以及想改的 `model`）**：

```json
{
  "api_base_url": "https://your-provider.com/v1",
  "api_key": "sk-你的真实密钥",
  "model": "gpt-image-2",
  "size": "1024x1024",
  "save_dir": "",
  "moderation": {
    "enabled": false,
    "api_base_url": "",
    "api_key": "",
    "model": "",
    "prompt": ""
  }
}
```

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| `api_base_url` | **你自己的**图像 API 根地址（到 `/v1`）| `https://your-provider.com/v1` |
| `api_key` | **你自己的** Bearer Token | `sk-xxxxxxxxxxxxxxxx` |
| `model` | 默认模型 id | `gpt-image-2` |
| `size` | 默认尺寸（`1024x1024` / `1024x1536` 竖 / `1536x1024` 横）| `1024x1024` |
| `save_dir` | 自动保存图片的目录；留空 `""` 不保存 | `~/Pictures/gen` |

**方式 B（懒人版）**：跳过上面的文件操作，接入客户端后直接在对话里说：

> 「端点改成 https://你的供应商.com/v1，key 更新为 sk-你的key，模型换成 gpt-image-2」

server 会自动创建 `config.json` 并保存，效果一样。

---

## 第 5 步：安装依赖

```bash
uv sync
```

看到 `Resolved ...` 和 `Installed ...` 即成功。依赖只有 MCP SDK 等基础库（HTTP 用 Python 标准库）。

---

## 第 6 步：接入你的 MCP 客户端

> 下面的 `<uv 绝对路径>` 和 `<部署目录的绝对路径>` 怎么填：见本步最后的「怎么填路径」。

### Codex

编辑 `~/.codex/config.toml`，在 `[mcp_servers]` 段下加入（注意 TOML 格式，已有 `[mcp_servers]` 就追加子段，不要重复建表）：

```toml
[mcp_servers.GPT-image]
command = "<uv 绝对路径>"
args = ["run", "--directory", "<部署目录的绝对路径>", "image-mcp-server"]
startup_timeout_sec = 60

[mcp_servers.GPT-image.env]
IMAGE_CONFIG_PATH = "<部署目录的绝对路径>/src/image_mcp_server/config.json"
PATH = "/Users/<你的用户名>/.local/bin:/usr/local/bin:/usr/bin:/bin"
```

保存后，先命令行确认能被识别：

```bash
codex mcp list
```

看到 `GPT-image` 且状态为 `enabled` 即成功。

### ZCode

编辑 `~/.zcode/cli/config.json`，在 `mcp.servers` 中加入：

```json
{
  "mcp": {
    "servers": {
      "GPT-image": {
        "type": "stdio",
        "command": "<uv 绝对路径>",
        "args": [
          "run",
          "--directory",
          "<部署目录的绝对路径>",
          "image-mcp-server"
        ],
        "env": {
          "IMAGE_CONFIG_PATH": "<部署目录>/src/image_mcp_server/config.json",
          "PATH": "/Users/<你的用户名>/.local/bin:/usr/local/bin:/usr/bin:/bin"
        },
        "timeoutMs": 60000
      }
    }
  }
}
```

### Claude Desktop

编辑（macOS）`~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "GPT-image": {
      "command": "<uv 绝对路径>",
      "args": [
        "run",
        "--directory",
        "<部署目录的绝对路径>",
        "image-mcp-server"
      ],
      "env": {
        "IMAGE_CONFIG_PATH": "<部署目录>/src/image_mcp_server/config.json"
      }
    }
  }
}
```

> ⚠️ 三者区别：Codex / ZCode 用 `mcp_servers`（Codex 是 TOML 的 `[mcp_servers.GPT-image]`，ZCode 是 JSON 的 `mcp.servers`），Claude 用**顶层 `mcpServers`**。

### 怎么填 `<uv 绝对路径>` 和 `<部署目录的绝对路径>`

```bash
which uv                                    # →  uv 绝对路径，如 /Users/wenkezhi/.local/bin/uv
pwd                                         # →  当前所在目录，即部署目录
```

> `command` 一定要用**绝对路径**，否则客户端启动时可能 `command not found`（PATH 不全）。

### Cursor 等其它客户端

按对应文档填等价 stdio 配置：command = uv 绝对路径，args = `["run","--directory","<部署目录>","image-mcp-server"]`，env 里带上 `IMAGE_CONFIG_PATH`。

---

## 第 7 步：重启客户端并验证

1. **完全退出客户端再重开**（MCP 配置在启动时才加载）
2. Codex：`codex mcp list` 确认 `GPT-image` 为 `enabled`，然后**开一个新会话**
3. 对话里说「**查看当前配置**」→ 应返回打码后的配置（key 形如 `sk-xxxx...xxxx`，端点是你自己填的）
4. 对话里说「**画一只柴犬**」→ 出图即部署成功 🎉

---

## 日常使用：对话里就能改配置

接入后，所有改动在对话里说人话即可，**改完立即生效，无需重启**：

| 你说 | 执行 |
| --- | --- |
| 「查看当前配置」 | `get_config` |
| 「把模型换成 dall-e-3」 | `set_config(model="dall-e-3")` |
| 「端点改成 https://xxx.com/v1」 | `set_config(api_base_url=...)` |
| 「更新 key 为 sk-yyy」 | `set_config(api_key="sk-yyy")` |
| 「设个保存目录 ~/Pictures/gen」 | `set_config(save_dir="...")` |
| 「列出后端有哪些模型」 | `list_image_models()` |
| 「画一只柴犬，竖图」 | `generate_image(prompt=..., size="1024x1536")` |

---

## 本地调试（可选）

不接客户端，直接验证 server：

```bash
# 直接调工具函数（无需 config.json，未配置时也能看默认状态）
uv run python -c "
from image_mcp_server.server import get_config
print(get_config())
"

# 或先用模板配置，再验证读取
cp src/image_mcp_server/config.example.json src/image_mcp_server/config.json
# （编辑 config.json 填入你的 key 后）
uv run python -c "
from image_mcp_server.server import get_config
print(get_config())
"
```

---

## 常见问题

| 现象 | 解决 |
| --- | --- |
| `uv sync` 报 `Readme file does not exist: README.md` | 你拿到的是旧版分发包（缺 `README.md`）；请向分发者要新版，或在目录里补一个 `README.md` |
| 状态 `failed: ENOENT` / `command not found` | `command` 用 uv 的**绝对路径**，并在 `env` 里补 `PATH` |
| `failed: timed out after 30000ms` | 首次启动慢，调大 `timeoutMs` / `startup_timeout_sec` 到 60000 |
| 生成报 403 / Cloudflare Error 1010 | server 已内置浏览器 UA；若仍失败检查供应商是否限制直连 |
| 生成报 401 / Unauthorized | ① `config.json` 的 `api_key` 错误或过期；② **key 与 `api_base_url` 不配套**（key 是 A 家的却填了 B 家端点） |
| `Upstream returned non-JSON` | `api_base_url` 拼错，确认到 `/v1` 这一级 |
| 没建 `config.json` 时调用报 "API key is not set" | 正常：先用对话 `set_config` 填 key（会自动创建 `config.json`），或按第 4 步复制模板 |
| 改配置不生效 | 换新会话；`set_config` 对**后续**调用立即生效 |
| `IMAGE_API_KEY is not set` 类报错 | 用的是旧版；新版改读 `config.json`，确认第 4 步已填 |
| 生图很慢 / 偶尔卡顿 | 开了审核会多一次模型调用；若审核服务不通会等超时（30s 内放行）|

---

## AI 审核（可选，保护账号防风控）

开启后，**每个提示词在进入生图账号前**会先调用一个审核模型，审核不通过直接拒绝，避免违规提示词触达账号造成风控或封号。

### 工作方式

1. 生图前，把提示词发给审核模型（OpenAI 兼容的 `chat/completions` 接口）
2. 审核模型回复 `ALLOW`（放行）或 `DENY: <原因>`（拒绝）
3. `DENY` 时直接拒绝出图，并把原因告诉调用方
4. **审核服务连不上时自动放行（fail-open）**，不影响正常出图

### 配置（两种方式）

**方式 A：编辑 config.json**（第 4 步模板已含此段）

```json
"moderation": {
  "enabled": true,
  "api_base_url": "http://your-moderation-host:8080/v1",
  "api_key": "sk-审核模型的密钥",
  "model": "deepseek-v4-flash",
  "prompt": ""
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | `true` 开启审核，`false` 关闭 |
| `api_base_url` | 审核模型的 OpenAI 兼容根地址 |
| `api_key` | 审核接口的 Bearer Token |
| `model` | 审核用的模型 id |
| `prompt` | 审核系统提示词，描述哪些内容禁止。留空用内置默认 |

**方式 B：对话里说人话**（改完立即生效）

| 你说 | 执行 |
| --- | --- |
| 「打开审核」 | `set_moderation(enabled=true)` |
| 「关闭审核」 | `set_moderation(enabled=false)` |
| 「审核模型换成 gpt-4o-mini」 | `set_moderation(model="gpt-4o-mini")` |
| 「审核端点改成 ...」 | `set_moderation(api_base_url=...)` |
| 「审核提示词改成：禁止 NSFW、暴力...」 | `set_moderation(prompt="...")` |

### 默认审核提示词（`prompt` 留空时）

内置默认判定标准：拒绝未成年人性内容、写实暴力血腥、未经同意的性内容、真人诽谤、仇恨意象等。自定义 `prompt` 可覆盖。

---

## 安全须知

- `config.json` 含 API Key，**已加入 `.gitignore`**，切勿提交 git。
- **发给别人之前，务必删除/排除 `config.json`**（第 2 步有打包命令），只保留 `config.example.json` 模板。
- 多机/多用户部署，各自维护各自的 `config.json`，各用自己的 Key。
- `get_config` 返回时 key 自动打码，不会在对话泄露全量。
- 怀疑泄露立即到供应商后台吊销并更换。

---

## 卸载

1. 客户端配置中删除 `GPT-image` 条目，重启客户端。
2. 删除部署目录：`rm -rf <部署目录>`。
3. 到供应商后台吊销不再使用的 key。
