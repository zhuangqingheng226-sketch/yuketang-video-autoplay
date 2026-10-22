#!/usr/bin/env bash
# macOS / Linux 入口：./run.sh [limit]
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[x] 没找到 node，请先安装 Node 18+ (https://nodejs.org)" >&2
  exit 1
fi

if [ ! -f node_modules/playwright-core/package.json ]; then
  echo "[*] 安装 playwright-core ..."
  npm install playwright-core --no-audit --no-fund --loglevel=error
fi

exec node autoplay.mjs "$@"