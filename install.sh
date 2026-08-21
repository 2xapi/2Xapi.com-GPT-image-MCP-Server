#!/usr/bin/env bash
# =============================================================================
# GPT-image MCP Server · 一键安装脚本
# 支持客户端：Claude Code (claude) / Codex (codex)
# 用法：
#   IMAGE_API_KEY=你的key ./install.sh                     # 自动检测客户端
#   IMAGE_API_KEY=你的key CLIENT=claude ./install.sh       # 指定客户端
#   IMAGE_API_KEY=你的key ./install.sh --no-verify          # 跳过验证
# =============================================================================
set -euo pipefail

# ---------- 参数 ----------
VERIFY=1
CLIENT="${CLIENT:-auto}"
for arg in "$@"; do
  case "$arg" in
    --no-verify) VERIFY=0 ;;
    *) echo "未知参数: $arg（忽略）" ;;
  esac
done

# ---------- tgz 下载地址（GitHub Release） ----------
TGZ_URL="https://github.com/wenkezhi8/2Xapi.com-GPT-image-MCP-Server/releases/download/v0.3.0/gpt-image-mcp-server-0.3.0.tgz"

# ---------- 0. 检查 key ----------
if [ -z "${IMAGE_API_KEY:-}" ]; then
  echo "❌ 缺少 IMAGE_API_KEY。请这样运行："
  echo "   IMAGE_API_KEY=你的key $0"
  exit 1
fi

# ---------- 1. 检查 Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js。请先安装 Node.js 18+（https://nodejs.org）后重试。"
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Node.js 版本过低（$(node -v)），需要 18+。请升级后重试。"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# ---------- 2. 选择客户端 ----------
if [ "$CLIENT" = "auto" ]; then
  if command -v claude >/dev/null 2>&1; then CLIENT=claude
  elif command -v codex >/dev/null 2>&1; then CLIENT=codex
  else
    echo "❌ 未检测到 claude 或 codex 命令。请先安装目标客户端，或用 CLIENT=... 指定。"
    exit 1
  fi
fi

echo "✅ 目标客户端: $CLIENT"

# ---------- 3. 执行接入 ----------
case "$CLIENT" in
  claude)
    if ! command -v claude >/dev/null 2>&1; then
      echo "❌ 未检测到 claude 命令。"
      exit 1
    fi
    claude mcp add -s user gpt-image \
      --env IMAGE_API_KEY="$IMAGE_API_KEY" \
      -- npx -y "$TGZ_URL"
    echo "✅ 已写入 Claude Code 配置"
    ;;
  codex)
    if ! command -v codex >/dev/null 2>&1; then
      echo "❌ 未检测到 codex 命令。"
      exit 1
    fi
    codex mcp add GPT-image \
      --env IMAGE_API_KEY="$IMAGE_API_KEY" \
      -- npx -y "$TGZ_URL"
    echo "✅ 已写入 Codex 配置"
    ;;
  *)
    echo "❌ 不支持的客户端: $CLIENT（支持 claude / codex）"
    exit 1
    ;;
esac

# ---------- 4. 验证 ----------
if [ "$VERIFY" = "1" ]; then
  echo ""
  echo "🔍 验证中..."
  case "$CLIENT" in
    claude) claude mcp list 2>/dev/null | grep -i gpt-image && echo "✅ 配置可见（重启客户端后生效）" || echo "⚠️ 未能从列表中确认，请重启客户端后在 MCP 列表查看" ;;
    codex)  codex mcp list 2>/dev/null | grep -i gpt-image && echo "✅ 配置可见（新会话生效）" || echo "⚠️ 未能从列表中确认，请新开会话后在 MCP 列表查看" ;;
  esac
fi

echo ""
echo "🎉 安装完成！接下来："
echo "   1. 完全退出并重开客户端（配置在启动时加载）"
echo "   2. 对话里说「画一只柴犬」→ 出图即成功"
