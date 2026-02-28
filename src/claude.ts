/**
 * claude.ts — Wrapper around the Claude Code CLI (`claude -p`).
 *
 * Provides both synchronous (execSync) and streaming (spawn) interfaces
 * to the Claude CLI. Handles argument construction, stdin piping, and
 * output parsing.
 *
 * Key invariants:
 *   - Prompt is ALWAYS sent via stdin (never as a CLI argument)
 *   - --session-id is ALWAYS present (enables KV cache)
 *   - --continue is used only from turn 2 onwards
 *   - --output-format stream-json REQUIRES --verbose
 *   - --max-turns is ALWAYS set to prevent infinite loops
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import { config } from './config';
import { ClaudeCLIResponse } from './translate';

/**
 * Returns a copy of process.env without the CLAUDECODE variable.
 * Claude CLI refuses to start if it detects it's running inside
 * another Claude Code session (via this env var).
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

/**
 * Arguments for constructing a Claude CLI command.
 */
export interface ClaudeArgs {
  model: string;
  systemPrompt: string | null;
  sessionId: string;
  continueSession: boolean;
  stream: boolean;
  tools: string;
}

/**
 * A single event from Claude CLI's stream-json output.
 */
export interface StreamEvent {
  type: string;
  event?: {
    type: string;
    content_block?: { type: string };
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
    };
  };
  result?: string;
  session_id?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
}

/**
 * Builds the argument array for the Claude CLI command.
 * Applies all required flags per PRD invariants.
 *
 * @param opts - Configuration for this CLI call
 * @returns Array of CLI arguments (without the 'claude' binary name)
 */
function buildArgs(opts: ClaudeArgs): string[] {
  const args = ['-p'];

  args.push('--model', opts.model);

  if (opts.continueSession) {
    // Resume a specific session by ID — enables KV cache hits
    args.push('--resume', opts.sessionId);
  } else {
    // First turn: create a new session with this ID
    args.push('--session-id', opts.sessionId);
  }

  // Output format
  if (opts.stream) {
    args.push('--output-format', 'stream-json');
    // --verbose is REQUIRED with stream-json, otherwise Claude CLI
    // exits with a non-zero code and produces no output
    args.push('--verbose');
    // --include-partial-messages enables token-by-token streaming deltas
    args.push('--include-partial-messages');
  } else {
    args.push('--output-format', 'json');
  }

  // Allowed tools
  args.push('--allowedTools', opts.tools);

  // System prompt (only on first turn — subsequent turns inherit from session)
  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  // Safety: cap agent turns to prevent infinite tool-use loops
  args.push('--max-turns', String(config.maxTurns));

  return args;
}

/**
 * Calls Claude CLI synchronously and returns the parsed JSON response.
 * The prompt is sent via stdin to avoid shell escaping issues and
 * argument length limits.
 *
 * @param prompt - Text to send to Claude via stdin
 * @param opts - CLI configuration options
 * @returns Parsed Claude CLI JSON response
 * @throws Error if the CLI exits with non-zero code or output is not valid JSON
 */
export function callClaudeSync(prompt: string, opts: ClaudeArgs): ClaudeCLIResponse {
  const args = buildArgs({ ...opts, stream: false });

  const stdout = execSync(['claude', ...args].join(' '), {
    input: prompt,
    encoding: 'utf-8',
    maxBuffer: config.maxBufferBytes,
    timeout: config.timeoutMs,
    env: cleanEnv(),
  });

  return JSON.parse(stdout);
}

/**
 * Calls Claude CLI in streaming mode, yielding parsed events as they arrive.
 * Uses spawn + readline to process line-delimited JSON from stdout.
 *
 * Thinking blocks are present in the stream but should be filtered by the
 * caller — this function yields ALL events including thinking deltas.
 *
 * @param prompt - Text to send to Claude via stdin
 * @param opts - CLI configuration options
 * @yields StreamEvent objects parsed from each line of stdout
 * @throws Error if the CLI process exits with non-zero code
 */
export async function* callClaudeStream(
  prompt: string,
  opts: ClaudeArgs
): AsyncGenerator<StreamEvent> {
  const args = buildArgs({ ...opts, stream: true });

  const child: ChildProcess = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cleanEnv(),
  });

  // Send prompt via stdin
  child.stdin!.write(prompt);
  child.stdin!.end();

  // Collect stderr for error reporting
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const rl = readline.createInterface({ input: child.stdout! });

  for await (const line of rl) {
    try {
      yield JSON.parse(line) as StreamEvent;
    } catch {
      // Skip non-JSON lines (progress indicators, etc.)
    }
  }

  // Wait for process to fully close
  await new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(stderr || `Claude CLI exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}
