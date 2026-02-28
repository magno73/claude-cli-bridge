/**
 * sessions.ts — In-memory session tracker with TTL-based expiry.
 *
 * Maps conversation IDs to Claude CLI session IDs so that subsequent
 * messages in the same conversation reuse the Claude session, enabling
 * prompt caching (KV cache hits) and reducing token consumption.
 *
 * Sessions are stored in a Map and expire after a configurable TTL
 * (default: 30 minutes). No persistence — if the bridge restarts,
 * sessions are lost and recreated on the next request.
 */

import { randomUUID } from 'crypto';

/**
 * Represents a single Claude CLI session tied to a conversation.
 */
export interface Session {
  /** UUID passed to claude --session-id */
  claudeSessionId: string;
  /** Number of turns completed in this session */
  turnCount: number;
  /** Timestamp (ms) of last activity */
  lastUsedAt: number;
  /** Number of messages OpenClaw has sent in this conversation */
  messageCount: number;
}

/**
 * OpenAI-format message used for conversation key generation.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string }>;
}

/**
 * Tracks Claude CLI sessions keyed by conversation identifier.
 * Handles creation, lookup, TTL-based expiry, and periodic cleanup.
 */
export class SessionTracker {
  private sessions = new Map<string, Session>();
  private ttlMs: number;
  private cleanupInterval: NodeJS.Timeout;

  constructor(ttlMs = 30 * 60 * 1000) {
    this.ttlMs = ttlMs;
    // Periodic cleanup of expired sessions every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Returns the number of active (non-expired) sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Retrieves a session if it exists and has not expired.
   * Expired sessions are removed and null is returned.
   *
   * @param conversationKey - Unique key identifying the conversation
   * @returns The session or null if not found / expired
   */
  get(conversationKey: string): Session | null {
    const session = this.sessions.get(conversationKey);
    if (!session) return null;

    if (Date.now() - session.lastUsedAt > this.ttlMs) {
      this.sessions.delete(conversationKey);
      return null;
    }

    return session;
  }

  /**
   * Creates a new session for a conversation.
   * Generates a random UUID for the Claude CLI --session-id flag.
   *
   * @param conversationKey - Unique key identifying the conversation
   * @returns The newly created session
   */
  create(conversationKey: string): Session {
    const session: Session = {
      claudeSessionId: randomUUID(),
      turnCount: 0,
      lastUsedAt: Date.now(),
      messageCount: 0,
    };
    this.sessions.set(conversationKey, session);
    return session;
  }

  /**
   * Updates the last-used timestamp and increments the turn count.
   * Called after a successful Claude CLI response.
   *
   * @param conversationKey - Unique key identifying the conversation
   */
  touch(conversationKey: string): void {
    const session = this.sessions.get(conversationKey);
    if (session) {
      session.lastUsedAt = Date.now();
      session.turnCount++;
      session.messageCount++;
    }
  }

  /**
   * Removes a session from the tracker.
   * Used when Claude returns a session error so the next request
   * creates a fresh session.
   *
   * @param conversationKey - Unique key identifying the conversation
   */
  delete(conversationKey: string): void {
    this.sessions.delete(conversationKey);
  }

  /**
   * Generates a conversation key from the request.
   * Uses X-Conversation-Id header if present, otherwise hashes
   * the first few messages to fingerprint the conversation.
   *
   * @param conversationId - Value of X-Conversation-Id header, or null
   * @param messages - Full message array from the OpenAI-format request
   * @returns A stable string key for this conversation
   */
  static makeKey(conversationId: string | null, messages: Message[]): string {
    if (conversationId) return conversationId;

    // Hash system prompt + first user message to fingerprint the conversation
    const fingerprint = messages
      .slice(0, 3)
      .map(m => {
        let text = '';
        if (typeof m.content === 'string') text = m.content;
        else if (Array.isArray(m.content)) text = m.content.filter(p => p.type === 'text' && p.text).map(p => p.text!).join(' ');
        return `${m.role}:${text.substring(0, 200)}`;
      })
      .join('|');

    // Simple non-crypto hash — collision resistance is not critical here
    let hash = 0;
    for (let i = 0; i < fingerprint.length; i++) {
      hash = ((hash << 5) - hash + fingerprint.charCodeAt(i)) | 0;
    }
    return `conv-${Math.abs(hash).toString(36)}`;
  }

  /**
   * Removes all sessions that have exceeded the TTL.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastUsedAt > this.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }

  /**
   * Stops the periodic cleanup timer.
   * Call this before shutting down to prevent resource leaks.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
