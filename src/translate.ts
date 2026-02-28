/**
 * translate.ts — Bidirectional translation between OpenAI chat format and Claude CLI.
 *
 * Handles two directions:
 *   1. OpenAI messages → Claude CLI input (first turn vs continue turn)
 *   2. Claude CLI response → OpenAI chat completion response (sync + streaming)
 *
 * The key insight: on the first turn, the full conversation context is sent
 * to Claude. On subsequent turns (--continue), only the last user message
 * is sent because the prior context lives in Claude's KV cache.
 */

import { Message } from './sessions';

/**
 * Extracts plain text from an OpenAI content field.
 * Handles both string content and array content (multipart format).
 *
 * @param content - String or array of content parts
 * @returns Plain text string
 */
function extractText(content: string | Array<{ type: string; text?: string }> | unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } => p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n');
  }
  return String(content ?? '');
}

/**
 * Result of translating OpenAI messages into Claude CLI input.
 */
export interface TranslatedInput {
  /** Text to send to claude -p via stdin */
  prompt: string;
  /** System prompt for --system-prompt flag (first turn only) */
  systemPrompt: string | null;
  /** Whether this is the first turn (determines --continue usage) */
  isFirstTurn: boolean;
}

/**
 * Claude CLI JSON response structure (--output-format json).
 */
export interface ClaudeCLIResponse {
  type: string;
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
}

/**
 * OpenAI-compatible chat completion response.
 */
export interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [{
    index: 0;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'error';
  }];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_read_tokens?: number;
  };
}

/**
 * Translates OpenAI messages for the first turn of a conversation.
 * Sends the full context (system prompt + all messages) so Claude
 * can populate its KV cache for subsequent turns.
 *
 * @param messages - Full conversation history from OpenAI-format request
 * @returns Translated input with system prompt extracted separately
 */
export function translateFirstTurn(messages: Message[]): TranslatedInput {
  const systemMessages = messages.filter(m => m.role === 'system');
  const systemPrompt = systemMessages.length > 0
    ? systemMessages.map(m => extractText(m.content)).join('\n')
    : null;

  // Everything except system messages becomes the prompt
  const conversation = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      const text = extractText(m.content);
      if (m.role === 'user') return `User: ${text}`;
      if (m.role === 'assistant') return `Assistant: ${text}`;
      return text;
    })
    .join('\n\n');

  return { prompt: conversation, systemPrompt, isFirstTurn: true };
}

/**
 * Translates OpenAI messages for a continue turn.
 * Extracts only the last user message — all prior context is already
 * in Claude's session cache via --session-id + --continue.
 *
 * @param messages - Full conversation history from OpenAI-format request
 * @returns Translated input with just the last user message
 * @throws Error if no user message is found in the array
 */
export function translateContinueTurn(messages: Message[]): TranslatedInput {
  const lastUserMessage = [...messages]
    .reverse()
    .find(m => m.role === 'user');

  if (!lastUserMessage) {
    throw new Error('No user message found in messages array — cannot continue conversation');
  }

  return {
    prompt: extractText(lastUserMessage.content),
    systemPrompt: null,
    isFirstTurn: false,
  };
}

/**
 * Translates a Claude CLI JSON response into OpenAI chat completion format.
 *
 * @param claude - Raw response from claude -p --output-format json
 * @param model - Model name to include in the response
 * @returns OpenAI-compatible chat completion response
 */
export function translateResponse(claude: ClaudeCLIResponse, model: string): OpenAIResponse {
  return {
    id: `chatcmpl-${claude.session_id || Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: claude.result,
      },
      finish_reason: claude.is_error ? 'error' : 'stop',
    }],
    usage: {
      prompt_tokens: claude.usage?.input_tokens || 0,
      completion_tokens: claude.usage?.output_tokens || 0,
      total_tokens: (claude.usage?.input_tokens || 0) + (claude.usage?.output_tokens || 0),
      cache_read_tokens: claude.usage?.cache_read_input_tokens || 0,
    },
  };
}

/**
 * Formats a text chunk as an OpenAI SSE streaming chunk.
 *
 * @param id - Completion ID (consistent across all chunks in a stream)
 * @param text - Text content for this chunk
 * @param model - Model name to include in the chunk
 * @returns Formatted SSE data line
 */
export function formatSSEChunk(id: string, text: string, model: string): string {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: { content: text },
      finish_reason: null,
    }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Formats the final SSE chunk that signals stream completion.
 * Includes finish_reason: "stop" followed by the [DONE] sentinel.
 *
 * @param id - Completion ID (consistent across all chunks in a stream)
 * @param model - Model name to include in the chunk
 * @returns Formatted SSE data lines including [DONE] sentinel
 */
export function formatSSEDone(id: string, model: string): string {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'stop',
    }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

/**
 * Maps OpenAI-style model names to Claude CLI model identifiers.
 *
 * @param requestModel - Model name from the OpenAI-format request
 * @param defaultModel - Fallback model if the request model is not recognized
 * @returns Claude CLI model identifier
 */
export function mapModel(requestModel: string | undefined, defaultModel: string): string {
  if (!requestModel) return defaultModel;

  const normalized = requestModel.toLowerCase();
  if (normalized.includes('haiku')) return 'haiku';
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('sonnet')) return 'sonnet';

  return defaultModel;
}
