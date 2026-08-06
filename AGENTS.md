# AGENTS.md — AI 部署指南

本仓库是 **GPT-image MCP Server**：把 OpenAI 兼容的文生图接口封装成 MCP 工具。

**你的任务（当用户说“部署 / 一键部署 / 配置这个 MCP / 帮我接入”时）**：
把本项目作为 MCP server 接入用户指定的客户端（Codex / Claude Code / Claude Desktop / Cursor），让用户能在对话里说「画一只柴犬」直接出图。

## 关键规则

1. **API Key 必须由用户提供**：不要编造、不要从仓库里找（仓库不含真实 key）。用户没说 key 时先询问。
2. **key 与端点必须配套**：`IMAGE_API_KEY` 是哪家供应商的，`IMAGE_API_BASE_URL` 就填哪家的（不填则用代码内置默认端点）。
3. **默认端点是 2xapi.com 中转站方案**：内置默认端点为 `https://2xa.cc.cd/v1`（2xapi.com 中转站，官网 https://2Xapi.com），本 MCP 默认配套该中转站的生图方案；用户使用 2xapi.com 的 key 时无需配置端点。**如果要使用其他 API 端点（OpenAI 官方 / Azure / 其他中转站），需要用户自行更换**：设置 `IMAGE_API_BASE_URL` 环境变量（npm 版），或修改 `config.json` 的 `api_base_url`（Python 版）。
4. **优先 npm 版**（`gpt-image-mcp-server/`，TypeScript，Node 18+）；Python 版（`src/`）作为备选，仅当用户环境没有 Node 时使用。
5. **不要提交/外发 `config.json`**：它含真实 key，已被 `.gitignore` 排除。
6. 所有配置写在客户端配置里（环境变量方式），不要改仓库内文件。

## 部署步骤

### 1. 确认环境

```bash
node -v   # 需要 >= 18
```

没有 Node：提示用户安装 Node.js 18+（或改用 Python 版：`python3 --version` + `uv --version`）。

### 2. 安装依赖并构建 npm 版

```bash
cd gpt-image-mcp-server
npm install
npm run build     # 生成 dist/index.js
```

### 3. 获取用户的 API Key

向用户询问（一次性）：

- `IMAGE_API_KEY`（必填）— 形如 `sk-xxxxxxxx`
- `IMAGE_API_BASE_URL`（可选）— 到 `/v1` 一级；不填用内置默认

### 4. 接入客户端（关键命令）

- **Codex**（推荐，先问用户用什么客户端）：

```bash
codex mcp add GPT-image --env IMAGE_API_KEY=用户的key -- node /绝对路径/gpt-image-mcp-server/dist/index.js
```

（`/绝对路径` = 仓库的绝对路径，例如 `/Users/xxx/2Xapi.com-GPT-image-MCP-Server`）

- **Claude Code**：

```bash
claude mcp add -s user gpt-image --env IMAGE_API_KEY=用户的key -- node /绝对路径/gpt-image-mcp-server/dist/index.js
```

- **Claude Desktop**：编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`，在顶层 `mcpServers` 加：

```json
{
  "mcpServers": {
    "GPT-image": {
      "command": "node",
      "args": ["/绝对路径/gpt-image-mcp-server/dist/index.js"],
      "env": { "IMAGE_API_KEY": "用户的key" }
    }
  }
}
```

- **Cursor 等其它客户端**：等价 stdio 配置，command = `node`，args = `["/绝对路径/gpt-image-mcp-server/dist/index.js"]`，env = `{ "IMAGE_API_KEY": "..." }`。

> 如果用户之前已用 `npx` 方式接入过，也可以直接用发布地址的 tgz URL 替代 `node /绝对路径/...`（见部署文档「快速开始」），但本机部署优先用绝对路径，最稳。

### 5. 验证

```bash
# 直接验证 server 能启动并响应初始化（应打印 {"jsonrpc":"2.0",...,"serverInfo":{"name":"GPT-image"}}）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}' | node /绝对路径/gpt-image-mcp-server/dist/index.js

# 客户端列表确认
codex mcp list      # 或 claude mcp list
```

应看到 `GPT-image` 且状态为 `enabled` / `connected`。

### 6. 告诉用户

- 完全退出并重开客户端（或开新会话）。
- 对话里说「查看当前配置」→ 应返回打码配置；
- 说「画一只柴犬」→ 出图即部署成功。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `command not found` / ENOENT | `command` 用 `node` 的绝对路径（`which node` 查看），env 里补 `PATH` |
| 401 Unauthorized | key 错误/过期，或 key 与 `IMAGE_API_BASE_URL` 不配套 |
| 连接超时 | 首次启动慢，客户端超时调到 60000ms；或检查网络代理 |
| `API key is not set` | 客户端 env 里没传 `IMAGE_API_KEY`，或变量名拼错 |
