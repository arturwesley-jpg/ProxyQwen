/*
 * File: context-summarizer.ts
 * Project: qwenproxy
 * Automatic context summarization to manage long conversations
 */

import Database from 'better-sqlite3';
import path from 'path';
import { createQwenStream } from '../services/qwen.js';
import { countTokens } from './token-estimation.js';
import { getModelContextWindow } from '../core/model-registry.js';

const DB_PATH = path.resolve('data', 'context_summaries.db');

export interface SummarizerConfig {
  enabled: boolean;
  threshold: number; // Trigger at X% of context window (default 0.8)
  model: string; // Model to use for summarization (default qwen3.6-27b)
  maxSummaryTokens: number; // Max tokens for summary (default 500)
  keepRecentMessages: number; // Keep last N messages unsummarized (default 5)
}

const DEFAULT_CONFIG: SummarizerConfig = {
  enabled: true,
  threshold: 0.8,
  model: 'qwen3.6-27b',
  maxSummaryTokens: 500,
  keepRecentMessages: 5,
};

interface CachedSummary {
  conversationId: string;
  summary: string;
  messageCount: number;
  tokensSaved: number;
  createdAt: number;
}

let db: Database.Database | null = null;
let config: SummarizerConfig = { ...DEFAULT_CONFIG };
const summaryCache = new Map<string, CachedSummary>();

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS context_summaries (
        conversation_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        tokens_saved INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_created ON context_summaries(created_at);
    `);
  }
  return db;
}

/**
 * Load summaries from DB into memory cache
 */
function loadSummaries(): void {
  if (!db) getDb();
  try {
    const rows = db!.prepare('SELECT * FROM context_summaries').all() as any[];
    for (const row of rows) {
      summaryCache.set(row.conversation_id, {
        conversationId: row.conversation_id,
        summary: row.summary,
        messageCount: row.message_count,
        tokensSaved: row.tokens_saved,
        createdAt: row.created_at,
      });
    }
    console.log(`[Summarizer] Loaded ${summaryCache.size} cached summaries`);
  } catch (err: any) {
    console.error('[Summarizer] Failed to load summaries:', err.message);
  }
}

/**
 * Check if conversation needs summarization
 */
export function needsSummarization(
  messages: Array<{ role: string; content: string | null }>,
  model: string
): boolean {
  if (!config.enabled) return false;
  if (messages.length <= config.keepRecentMessages) return false;

  const contextWindow = getModelContextWindow(model);
  const threshold = contextWindow * config.threshold;

  // Estimate current token count
  const totalText = messages.map(m => m.content || '').join('\n');
  const currentTokens = countTokens(totalText, model);

  return currentTokens > threshold;
}

/**
 * Generate summary of conversation history
 */
export async function summarizeConversation(
  conversationId: string,
  messages: Array<{ role: string; content: string | null }>,
  model: string
): Promise<{
  summarizedMessages: Array<{ role: string; content: string }>;
  tokensSaved: number;
} | null> {
  if (!config.enabled) return null;
  if (messages.length <= config.keepRecentMessages) return null;

  // Check cache first
  const cached = summaryCache.get(conversationId);
  if (cached) {
    console.log(`[Summarizer] Using cached summary for ${conversationId}`);
    return {
      summarizedMessages: [
        { role: 'system', content: `[SUMMARY]\n${cached.summary}` },
        ...messages.slice(-config.keepRecentMessages).map(m => ({
          role: m.role,
          content: m.content || '',
        })),
      ],
      tokensSaved: cached.tokensSaved,
    };
  }

  // Split messages: old (to summarize) + recent (to keep)
  const oldMessages = messages.slice(0, -config.keepRecentMessages);
  const recentMessages = messages.slice(-config.keepRecentMessages);

  // Calculate tokens before
  const oldText = oldMessages.map(m => `${m.role}: ${m.content || ''}`).join('\n');
  const tokensBefore = countTokens(oldText, model);

  // Generate summary prompt
  const summaryPrompt = `Summarize this conversation in under ${config.maxSummaryTokens} words. Preserve:
- Key facts and decisions
- Important context and constraints
- User goals and preferences
- Technical details that affect future responses

Conversation:
${oldText}

Summary:`;

  try {
    console.log(`[Summarizer] Generating summary for ${conversationId} (${oldMessages.length} messages)...`);
    
    // Call Qwen for summarization (using cheap model)
    const result = await createQwenStream(
      summaryPrompt,
      false, // no thinking
      config.model,
      null,
      undefined,
      undefined,
      undefined,
      undefined
    );

    // Collect summary from stream
    const reader = result.stream.getReader();
    const decoder = new TextDecoder();
    let summary = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;

        try {
          const chunk = JSON.parse(dataStr);
          if (chunk.choices?.[0]?.delta?.content) {
            summary += chunk.choices[0].delta.content;
          }
        } catch {}
      }
    }

    if (!summary || summary.length < 50) {
      console.warn('[Summarizer] Summary too short, skipping');
      return null;
    }

    // Calculate tokens saved
    const tokensAfter = countTokens(summary, model);
    const tokensSaved = tokensBefore - tokensAfter;

    // Cache and persist
    const cachedSummary: CachedSummary = {
      conversationId,
      summary,
      messageCount: oldMessages.length,
      tokensSaved,
      createdAt: Date.now(),
    };

    summaryCache.set(conversationId, cachedSummary);
    persistSummary(cachedSummary);

    console.log(
      `[Summarizer] Summary generated: ${oldMessages.length} messages → ${summary.length} chars, ` +
      `saved ${tokensSaved} tokens (${((tokensSaved / tokensBefore) * 100).toFixed(1)}% reduction)`
    );

    return {
      summarizedMessages: [
        { role: 'system', content: `[SUMMARY]\n${summary}` },
        ...recentMessages.map(m => ({ role: m.role, content: m.content || '' })),
      ],
      tokensSaved,
    };
  } catch (err: any) {
    console.error('[Summarizer] Failed to generate summary:', err.message);
    return null;
  }
}

/**
 * Persist summary to DB
 */
function persistSummary(summary: CachedSummary): void {
  try {
    getDb().prepare(`
      INSERT OR REPLACE INTO context_summaries 
      (conversation_id, summary, message_count, tokens_saved, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      summary.conversationId,
      summary.summary,
      summary.messageCount,
      summary.tokensSaved,
      summary.createdAt
    );
  } catch (err: any) {
    console.error('[Summarizer] Failed to persist summary:', err.message);
  }
}

/**
 * Delete summary for conversation
 */
export function deleteSummary(conversationId: string): void {
  summaryCache.delete(conversationId);
  try {
    getDb().prepare('DELETE FROM context_summaries WHERE conversation_id = ?').run(conversationId);
  } catch (err: any) {
    console.error('[Summarizer] Failed to delete summary:', err.message);
  }
}

/**
 * Get summarizer statistics
 */
export function getSummarizerStats(): {
  cachedCount: number;
  totalTokensSaved: number;
  avgTokensSaved: number;
  oldestSummary: number | null;
  newestSummary: number | null;
} {
  let totalTokensSaved = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const summary of summaryCache.values()) {
    totalTokensSaved += summary.tokensSaved;
    if (oldest === null || summary.createdAt < oldest) oldest = summary.createdAt;
    if (newest === null || summary.createdAt > newest) newest = summary.createdAt;
  }

  return {
    cachedCount: summaryCache.size,
    totalTokensSaved,
    avgTokensSaved: summaryCache.size > 0 ? totalTokensSaved / summaryCache.size : 0,
    oldestSummary: oldest,
    newestSummary: newest,
  };
}

/**
 * Update summarizer config
 */
export function setSummarizerConfig(partial: Partial<SummarizerConfig>): void {
  config = { ...config, ...partial };
  console.log('[Summarizer] Config updated:', config);
}

/**
 * Get current config
 */
export function getSummarizerConfig(): SummarizerConfig {
  return { ...config };
}

/**
 * Close DB connection
 */
export function closeSummarizerDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  summaryCache.clear();
}

// Load summaries on module init
loadSummaries();
