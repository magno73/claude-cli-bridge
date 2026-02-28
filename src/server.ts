/**
 * server.ts — HTTP server exposing Claude CLI as an OpenAI-compatible endpoint.
 *
 * Routes:
 *   GET  /health                → Health check with active session count
 *   GET  /v1/models             → Available model list
 *   POST /v1/chat/completions   → Chat completion (sync + streaming)
 *
 * The server listens on 127.0.0.1 only (no auth, not for public exposure).
 * Session management enables prompt caching: first turn sends full context,
 * subsequent turns use --continue with only the new message.
 */

import * as http from 'http';
import { config } from './config';
import { SessionTracker, Message } from './sessions';
import {
  translateFirstTurn,
  translateContinueTurn,
  translateResponse,
  formatSSEChunk,
  formatSSEDone,
  mapModel,
  TranslatedInput,
} from './translate';
import { callClaudeSync, callClaudeStream, ClaudeArgs } from './claude';

const sessions = new SessionTracker(config.sessionTtlMs);

/**
 * Reads the full request body from an IncomingMessage stream.
 *
 * @param req - HTTP request
 * @returns The raw body as a string
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Classifies Claude CLI errors into appropriate HTTP status codes.
 * Maps rate limits → 429, auth failures → 401, timeouts → 504,
 * session errors → 502, everything else → 502.
 *
 * @param error - The error thrown by the Claude CLI call
 * @param convKey - Conversation key to clean up if session error
 * @returns Object with HTTP status code and OpenAI-format error body
 */
function handleError(error: unknown, convKey?: string): { status: number; body: Record<string, unknown> } {
  const message = (error instanceof Error ? error.message : String(error)) || 'Unknown error';

  // Rate limited → 429 → OpenClaw falls back to Kimi
  if (message.includes('rate limit') || message.includes('quota') ||
      message.includes('cooldown') || message.includes('capacity')) {
    return { status: 429, body: { error: {
      message: 'Claude rate limited',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    }}};
  }

  // Auth expired → 401
  if (message.includes('not authorized') || message.includes('credential') ||
      message.includes('login')) {
    return { status: 401, body: { error: {
      message: 'Claude auth expired — run: claude login',
      type: 'authentication_error',
      code: 'invalid_api_key',
    }}};
  }

  // Timeout → 504
  if ((error as Record<string, unknown>)?.killed || message.includes('ETIMEDOUT') || message.includes('timeout')) {
    return { status: 504, body: { error: {
      message: 'Claude CLI timeout',
      type: 'timeout_error',
      code: 'timeout',
    }}};
  }

  // Session not found / corrupted → delete from tracker and return 502
  // Next request will create a fresh session
  if (message.includes('session') || message.includes('Session not found')) {
    if (convKey) {
      sessions.delete(convKey);
    }
    return { status: 502, body: { error: {
      message: 'Claude session expired, retry will create new session',
      type: 'server_error',
      code: 'session_expired',
    }}};
  }

  // Everything else → 502
  return { status: 502, body: { error: {
    message: `Claude CLI error: ${message.substring(0, 200)}`,
    type: 'server_error',
    code: 'internal_error',
  }}};
}

/**
 * Handles a streaming chat completion request.
 * Spawns Claude CLI in stream-json mode, filters thinking blocks,
 * and forwards text deltas as OpenAI SSE chunks.
 *
 * @param prompt - Text to send to Claude
 * @param claudeOpts - Claude CLI options
 * @param model - Model name for response formatting
 * @param convKey - Conversation key for session tracking
 * @param res - HTTP response to write SSE chunks to
 */
async function handleStream(
  prompt: string,
  claudeOpts: ClaudeArgs,
  model: string,
  convKey: string,
  res: http.ServerResponse,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const completionId = `chatcmpl-${Date.now()}`;

  // Track whether we're inside a thinking block so we skip all
  // events belonging to it (start, deltas, stop)
  let insideThinkingBlock = false;

  try {
    for await (const event of callClaudeStream(prompt, claudeOpts)) {
      // Handle final result event
      if (event.type === 'result') {
        sessions.touch(convKey);

        if (event.usage?.cache_read_input_tokens && event.usage.cache_read_input_tokens > 0) {
          console.log(`[cache] hit: ${event.usage.cache_read_input_tokens} tokens cached`);
        }

        res.write(formatSSEDone(completionId, model));
        res.end();
        return;
      }

      if (event.type === 'stream_event' && event.event) {
        const inner = event.event;

        // Track thinking block boundaries
        if (inner.type === 'content_block_start' && inner.content_block?.type === 'thinking') {
          insideThinkingBlock = true;
          continue;
        }

        if (inner.type === 'content_block_stop' && insideThinkingBlock) {
          insideThinkingBlock = false;
          continue;
        }

        // Skip all events inside thinking blocks
        if (insideThinkingBlock) continue;
        if (inner.delta?.type === 'thinking_delta') continue;

        // Forward text deltas as SSE chunks
        if (inner.delta?.text) {
          res.write(formatSSEChunk(completionId, inner.delta.text, model));
        }
      }
    }

    // If we reach here without a result event, send DONE anyway
    sessions.touch(convKey);
    res.write(formatSSEDone(completionId, model));
    res.end();
  } catch (error) {
    const { body } = handleError(error, convKey);
    // Try to send error as SSE if the stream is still writable
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: body.error })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

/**
 * Main handler for POST /v1/chat/completions.
 * Manages session lookup/creation, translates messages,
 * and dispatches to sync or streaming execution.
 */
async function handleChatCompletion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);

  let parsed: {
    model?: string;
    messages: Message[];
    stream?: boolean;
  };

  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: {
      message: 'Invalid JSON in request body',
      type: 'invalid_request_error',
      code: 'parse_error',
    }}));
    return;
  }

  if (!parsed.messages || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: {
      message: 'messages array is required and must not be empty',
      type: 'invalid_request_error',
      code: 'missing_messages',
    }}));
    return;
  }

  const model = mapModel(parsed.model, config.defaultModel);
  const messages = parsed.messages;

  // === Session management ===
  const conversationId = (req.headers['x-conversation-id'] as string) || null;
  const convKey = SessionTracker.makeKey(conversationId, messages);
  let session = sessions.get(convKey);

  let translated: TranslatedInput;
  if (!session) {
    // FIRST TURN: new session, send full context
    session = sessions.create(convKey);
    translated = translateFirstTurn(messages);
    console.log(`[session] new: ${convKey} → claude-session ${session.claudeSessionId}`);
  } else {
    // SUBSEQUENT TURNS: existing session, send only the last user message
    translated = translateContinueTurn(messages);
    console.log(`[session] continue: ${convKey} (turn ${session.turnCount + 1})`);
  }

  const claudeOpts: ClaudeArgs = {
    model,
    systemPrompt: translated.systemPrompt,
    sessionId: session.claudeSessionId,
    continueSession: !translated.isFirstTurn,
    stream: parsed.stream || false,
    tools: config.tools,
  };

  // === Execution ===
  if (parsed.stream) {
    await handleStream(translated.prompt, claudeOpts, parsed.model || config.defaultModel, convKey, res);
  } else {
    try {
      const claudeResp = callClaudeSync(translated.prompt, claudeOpts);
      sessions.touch(convKey);

      // Log cache hit for debugging
      if (claudeResp.usage?.cache_read_input_tokens > 0) {
        console.log(`[cache] hit: ${claudeResp.usage.cache_read_input_tokens} tokens cached`);
      }

      const openaiResp = translateResponse(claudeResp, parsed.model || config.defaultModel);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openaiResp));
    } catch (error) {
      const { status, body } = handleError(error, convKey);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }
  }
}

// === HTTP Server ===

const server = http.createServer(async (req, res) => {
  // CORS headers for local development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Conversation-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /health — health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      activeSessions: sessions.size,
    }));
    return;
  }

  // GET /v1/models — available models
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'claude-sonnet', object: 'model', owned_by: 'anthropic' },
        { id: 'claude-haiku', object: 'model', owned_by: 'anthropic' },
        { id: 'claude-opus', object: 'model', owned_by: 'anthropic' },
      ],
    }));
    return;
  }

  // POST /v1/chat/completions — chat completion
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    try {
      await handleChatCompletion(req, res);
    } catch (error) {
      console.error('[server] unhandled error in handleChatCompletion:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: {
          message: 'Internal server error',
          type: 'server_error',
          code: 'internal_error',
        }}));
      }
    }
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: {
    message: `Not found: ${req.method} ${req.url}`,
    type: 'invalid_request_error',
    code: 'not_found',
  }}));
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[bridge] Claude CLI Bridge v1.0.0`);
  console.log(`[bridge] Listening on http://127.0.0.1:${config.port}`);
  console.log(`[bridge] Default model: ${config.defaultModel}`);
  console.log(`[bridge] Session TTL: ${config.sessionTtlMs / 1000}s`);
  console.log(`[bridge] Max turns: ${config.maxTurns}`);
  console.log(`[bridge] Timeout: ${config.timeoutMs / 1000}s`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[bridge] SIGTERM received, shutting down...');
  sessions.destroy();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[bridge] SIGINT received, shutting down...');
  sessions.destroy();
  server.close(() => process.exit(0));
});
