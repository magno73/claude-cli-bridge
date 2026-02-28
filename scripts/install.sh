#!/bin/bash
set -euo pipefail

echo "=== Claude CLI Bridge - Setup ==="
echo ""

# Check Claude CLI is installed
if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: Claude Code CLI not found."
  echo "Install it with: npm i -g @anthropic-ai/claude-code"
  exit 1
fi
echo "[OK] Claude CLI found: $(command -v claude)"

# Check Claude is authenticated
echo "[..] Testing Claude authentication..."
if echo "test" | claude -p --model haiku --output-format json --allowedTools "" \
  --max-turns 1 2>/dev/null; then
  echo "[OK] Claude authentication works"
else
  echo "ERROR: Claude not authenticated. Run: claude login"
  exit 1
fi

# Check Node.js >= 18
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found. Install Node.js >= 18."
  exit 1
fi

NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_V" -ge 18 ]; then
  echo "[OK] Node.js $(node -v)"
else
  echo "ERROR: Node.js >= 18 required (found $(node -v))"
  exit 1
fi

echo ""
echo "All checks passed!"
echo "Build and start with:"
echo "  npm install && npm run build"
echo "  node dist/server.js"
