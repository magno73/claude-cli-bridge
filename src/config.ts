/**
 * config.ts — Bridge configuration with environment variable overrides.
 *
 * All settings have sensible defaults and can be overridden via environment
 * variables. The bridge is designed to run on localhost only (no auth).
 *
 * Environment variables:
 *   BRIDGE_PORT          — HTTP port (default: 3457)
 *   BRIDGE_MODEL         — Default Claude model (default: sonnet)
 *   BRIDGE_TOOLS         — Allowed Claude tools (default: Bash,Read,Write,Edit,Glob,Grep)
 *   BRIDGE_MAX_TURNS     — Max agent turns per request (default: 15)
 *   BRIDGE_TIMEOUT_MS    — Request timeout in ms (default: 300000 = 5 min)
 *   BRIDGE_SESSION_TTL_MS — Session expiry in ms (default: 1800000 = 30 min)
 */

export interface BridgeConfig {
  port: number;
  defaultModel: string;
  tools: string;
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  sessionTtlMs: number;
}

export const config: BridgeConfig = {
  port: parseInt(process.env.BRIDGE_PORT || '3457', 10),
  defaultModel: process.env.BRIDGE_MODEL || 'sonnet',
  tools: process.env.BRIDGE_TOOLS || 'Bash,Read,Write,Edit,Glob,Grep',
  maxTurns: parseInt(process.env.BRIDGE_MAX_TURNS || '15', 10),
  timeoutMs: parseInt(process.env.BRIDGE_TIMEOUT_MS || '300000', 10),
  maxBufferBytes: 50 * 1024 * 1024,
  sessionTtlMs: parseInt(process.env.BRIDGE_SESSION_TTL_MS || '1800000', 10),
};
