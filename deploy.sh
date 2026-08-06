#!/usr/bin/env bash
# GPT-image MCP Server 一键部署脚本
# 用法:
#   ./deploy.sh --client codex --key sk-你的key [--base-url https://your-provider.com/v1]
#   ./deploy.sh                                  # 交互式（会问你 key 和客户端）
#   ./deploy.sh --dry-run ...                    # 只打印要执行的命令，不真正修改
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT=""
KEY=""
BASE_URL=""
DRY_RUN=0

usage() {
  cat <<'USAGE'
GPT-image MCP Server 一键部署

用法:
  ./deploy.sh [--client codex|claude-code|claude-desktop|cursor] [--key sk-xxx] [--base-url https://xxx/v1] [--dry-run]

选项:
  --client    要接入的客户端（默认交互选择）
  --key       你的 API Key（不传则交互输入，不回显）
  --base-url  接口根地址，到 /v1 一级（不传则用内置默认）
  --dry-run   只打印命令，不执行
  -h, --help  显示帮助
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --client) CLIENT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
done

echo "==> [1/5] 检查环境（Node.js >= 18）"
if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未安装 Node.js。请先安装 Node.js 18+（https://nodejs.org）"
  exit 1
fi
NODE_MAJOR="$(node -e "console.log(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "错误: Node.js 版本过低（$(node -v)），需要 >= 18"
  exit 1
fi
echo "     Node.js $(node -v) ✓"

echo "==> [2/5] 安装依赖并构建 npm 版"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "     (dry-run) cd '$REPO_DIR/gpt-image-mcp-server' && npm install && npm run build"
else
  ( cd "$REPO_DIR/gpt-image-mcp-server" && npm install && npm run build )
  echo "     构建完成 ✓"
fi

echo "==> [3/5] 配置 API Key"
if [[ -z "$KEY" ]]; then
  read -rsp "     请输入你的 API Key（输入时不显示）: " KEY; echo
  if [[ -z "$KEY" ]]; then echo "错误: 未提供 API Key"; exit 1; fi
fi
if [[ -z "$BASE_URL" ]]; then
  read -rp "     接口根地址（回车用内置默认; 你的 key 是哪家的就填哪家，到 /v1）: " BASE_URL
fi
echo "     KEY: ${KEY:0:6}...${KEY: -4}（已打码显示）"
[[ -n "$BASE_URL" ]] && echo "     BASE_URL: $BASE_URL"

if [[ -z "$CLIENT" ]]; then
  echo
  echo "==> [4/5] 选择要接入的客户端"
  echo "     1) Codex         2) Claude Code      3) Claude Desktop      4) Cursor"
  read -rp "     请输入编号 [1]: " CHOICE
  case "${CHOICE:-1}" in
    1) CLIENT=codex ;;
    2) CLIENT=claude-code ;;
    3) CLIENT=claude-desktop ;;
    4) CLIENT=cursor ;;
    *) echo "无效选择，使用 Codex"; CLIENT=codex ;;
  esac
fi

SERVER="node '$REPO_DIR/gpt-image-mcp-server/dist/index.js'"
ENV_ARGS="--env IMAGE_API_KEY=$KEY"
[[ -n "$BASE_URL" ]] && ENV_ARGS="$ENV_ARGS --env IMAGE_API_BASE_URL=$BASE_URL"

echo "==> [5/5] 注册到 $CLIENT"
case "$CLIENT" in
  codex)
    CMD="codex mcp add GPT-image $ENV_ARGS -- $SERVER"
    if [[ "$DRY_RUN" -eq 1 ]]; then echo "     (dry-run) $CMD"; echo "     (dry-run) codex mcp list"; else
      eval "$CMD"
      codex mcp list
    fi
    ;;
  claude-code)
    CMD="claude mcp add -s user gpt-image $ENV_ARGS -- $SERVER"
    if [[ "$DRY_RUN" -eq 1 ]]; then echo "     (dry-run) $CMD"; echo "     (dry-run) claude mcp list"; else
      eval "$CMD"
      claude mcp list
    fi
    ;;
  claude-desktop|cursor)
    echo "     $CLIENT 需要手动添加配置，请把下面内容加入配置文件："
    echo "       Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json 的 mcpServers"
    echo "       Cursor: 设置 → MCP → 新增"
    echo
    echo '     {'
    echo '       "mcpServers": {'
    echo '         "GPT-image": {'
    echo '           "command": "node",'
    echo "           \"args\": [\"$REPO_DIR/gpt-image-mcp-server/dist/index.js\"],"
    echo '           "env": {'
    echo "             \"IMAGE_API_KEY\": \"$KEY\","
    [[ -n "$BASE_URL" ]] && echo "             \"IMAGE_API_BASE_URL\": \"$BASE_URL\","
    echo '           }'
    echo '         }'
    echo '       }'
    echo '     }'
    ;;
  *)
    echo "不支持的客户端: $CLIENT"; exit 1 ;;
esac

echo
echo "=================================================="
echo "部署完成！接下来："
echo "  1. 完全退出客户端再重开（或开新会话）"
echo "  2. 对话里说「查看当前配置」→ 应返回打码配置"
echo "  3. 对话里说「画一只柴犬」→ 出图即成功"
echo "=================================================="
