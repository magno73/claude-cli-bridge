# claude-cli-bridge

> Use your Claude Pro/Max subscription as an OpenAI-compatible API endpoint.

Anthropic restricts OAuth tokens from Claude subscriptions in third-party tools.
This bridge wraps the official Claude Code CLI (`claude -p`) as a standard
`/v1/chat/completions` HTTP endpoint, so any OpenAI-compatible client can use it.

## Why?

- You pay for Claude Pro ($20/mo) or Max ($100-200/mo) but can't use it in your apps
- Anthropic blocked OAuth tokens in January 2026 for non-Claude-Code clients
- Claude Code CLI (`claude -p`) still works with your subscription
- This bridge exposes it as a standard OpenAI-compatible API

## Features

- **OpenAI-compatible** — works with any client that speaks `/v1/chat/completions`
- **Session management** — conversations reuse Claude sessions for prompt caching
- **Prompt caching** — 2nd+ messages in a conversation hit the KV cache (faster, less quota)
- **Streaming (SSE)** — real-time token-by-token responses
- **Extended thinking** — Opus thinking blocks are handled transparently
- **Multipart content** — handles both string and array content formats (`[{"type":"text","text":"..."}]`)
- **Fail-fast errors** — returns proper HTTP status codes (429, 401, 502) for client-side fallback

## Quick Start

### Prerequisites

- Node.js >= 18
- Claude Code CLI installed and authenticated (`npm i -g @anthropic-ai/claude-code && claude login`)
- An active Claude Pro or Max subscription

### Install & Run

```bash
git clone https://github.com/magno73/claude-cli-bridge.git
cd claude-cli-bridge
npm install && npm run build
node dist/server.js
```

### Verify

```bash
curl http://localhost:3457/health
# {"status":"ok","activeSessions":0}

curl http://localhost:3457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"Hello!"}]}'
```

## Configuration

| Env variable | Default | Description |
|---|---|---|
| `BRIDGE_PORT` | `3457` | HTTP port |
| `BRIDGE_MODEL` | `sonnet` | Default Claude model |
| `BRIDGE_TOOLS` | `Bash,Read,...` | Allowed Claude tools |
| `BRIDGE_MAX_TURNS` | `15` | Max agent turns per request |
| `BRIDGE_TIMEOUT_MS` | `300000` | Request timeout (5 min) |
| `BRIDGE_SESSION_TTL_MS` | `1800000` | Session expiry (30 min) |

## Use with OpenClaw

```json
{
  "models": {
    "providers": {
      "claude-bridge": {
        "type": "openai",
        "baseUrl": "http://127.0.0.1:3457/v1",
        "apiKey": "not-needed"
      }
    }
  }
}
```

## Use with other OpenAI-compatible clients

Any client that supports a custom base URL works:

```python
# Python (openai SDK)
client = OpenAI(base_url="http://localhost:3457/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="claude-sonnet",
    messages=[{"role": "user", "content": "Hello"}]
)
```

```bash
# curl
curl http://localhost:3457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"Hello!"}]}'
```

## How it works

1. You send a standard OpenAI chat completion request
2. Bridge translates it to a `claude -p` CLI call
3. Sessions are tracked in-memory: first message sends full context,
   subsequent messages use `--resume` for prompt caching
4. Response is translated back to OpenAI format
5. If Claude is rate-limited, bridge returns HTTP 429 — your client
   can fall back to another provider

## Models

| Request model | Claude CLI model |
|---|---|
| `claude-haiku` | haiku |
| `claude-sonnet` (default) | sonnet |
| `claude-opus` | opus |

## Production

```bash
# pm2
pm2 start dist/server.js --name claude-bridge

# systemd — see systemd/claude-bridge.service
```

## Security

The bridge listens on `127.0.0.1` only. It has no authentication.
**Do not expose it to the internet.**

## License

MIT
