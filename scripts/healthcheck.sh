#!/bin/bash
# Quick health check for the Claude CLI Bridge.
# Returns exit code 0 if the bridge is healthy, 1 otherwise.

PORT="${BRIDGE_PORT:-3457}"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/health" 2>/dev/null)

if [ "$RESPONSE" = "200" ]; then
  echo "Bridge is healthy (port ${PORT})"
  exit 0
else
  echo "Bridge is not responding on port ${PORT} (HTTP ${RESPONSE})"
  exit 1
fi
