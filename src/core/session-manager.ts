/**
 * Session Manager - Persiste mapeamento conversation_id (cliente) -> chat_id (Qwen)
 * Permite reutilizar a mesma conversa no Qwen entre múltiplos requests,
 * preservando o contexto da conversa.
 */

import Database from 'better-sqlite3';
import path from 'path';

export interface SessionRecord {
  conversationId: string;
  qwenChatId: string;
  accountId: string;
  lastParentId: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

const DB_PATH = path.resolve('data', 'sessions.db');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 5000;

let db: Database.Database | null = null;
const memoryCache = new Map<string, SessionRecord & { cacheTime: number }>();

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        conversation_id TEXT PRIMARY KEY,
        qwen_chat_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        last_parent_id TEXT,
        message_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
    `);
  }
  return db;
}

function getCached(conversationId: string): SessionRecord | null {
  const entry = memoryCache.get(conversationId);
  if (!entry) return null;
  if (Date.now() - entry.cacheTime > CACHE_TTL_MS) {
    memoryCache.delete(conversationId);
    return null;
  }
  return entry;
}

function setCache(record: SessionRecord): void {
  if (memoryCache.size >= MAX_CACHE_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, val] of memoryCache) {
      if (val.cacheTime < oldestTime) {
        oldestTime = val.cacheTime;
        oldestKey = key;
      }
    }
    if (oldestKey) memoryCache.delete(oldestKey);
  }
  memoryCache.set(record.conversationId, { ...record, cacheTime: Date.now() });
}

export function getSession(conversationId: string): SessionRecord | null {
  const cached = getCached(conversationId);
  if (cached) return cached;
  try {
    const row = getDb().prepare(
      'SELECT * FROM sessions WHERE conversation_id = ?'
    ).get(conversationId) as SessionRecord | undefined;
    if (!row) return null;
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - row.updatedAt > maxAge) {
      deleteSession(conversationId);
      return null;
    }
    setCache(row);
    return row;
  } catch (err) {
    console.error('[SessionManager] Error getting session:', (err as Error).message);
    return null;
  }
}

export function createSession(
  conversationId: string,
  qwenChatId: string,
  accountId: string,
  lastParentId: string | null = null
): SessionRecord {
  const now = Date.now();
  const record: SessionRecord = {
    conversationId, qwenChatId, accountId, lastParentId,
    messageCount: 1, createdAt: now, updatedAt: now,
  };
  try {
    getDb().prepare(`
      INSERT OR REPLACE INTO sessions 
      (conversation_id, qwen_chat_id, account_id, last_parent_id, message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(record.conversationId, record.qwenChatId, record.accountId,
      record.lastParentId, record.messageCount, record.createdAt, record.updatedAt);
    setCache(record);
    console.log(`[SessionManager] Created session: ${conversationId} -> ${qwenChatId}`);
  } catch (err) {
    console.error('[SessionManager] Error creating session:', (err as Error).message);
  }
  return record;
}

export function updateSession(conversationId: string, lastParentId: string | null): void {
  try {
    getDb().prepare(`
      UPDATE sessions 
      SET last_parent_id = ?, message_count = message_count + 1, updated_at = ?
      WHERE conversation_id = ?
    `).run(lastParentId, Date.now(), conversationId);
    const cached = getCached(conversationId);
    if (cached) {
      cached.lastParentId = lastParentId;
      cached.messageCount++;
      cached.updatedAt = Date.now();
      setCache(cached);
    }
  } catch (err) {
    console.error('[SessionManager] Error updating session:', (err as Error).message);
  }
}

export function deleteSession(conversationId: string): void {
  try {
    getDb().prepare('DELETE FROM sessions WHERE conversation_id = ?').run(conversationId);
    memoryCache.delete(conversationId);
  } catch (err) {
    console.error('[SessionManager] Error deleting session:', (err as Error).message);
  }
}

export function cleanupOldSessions(maxAgeMs: number): number {
  try {
    const cutoff = Date.now() - maxAgeMs;
    const result = getDb().prepare('DELETE FROM sessions WHERE updated_at < ?').run(cutoff);
    memoryCache.clear();
    return result.changes;
  } catch (err) {
    console.error('[SessionManager] Error cleaning up:', (err as Error).message);
    return 0;
  }
}

export function getStats() {
  try {
    const d = getDb();
    const total = (d.prepare('SELECT COUNT(*) as count FROM sessions').get() as any).count;
    const oldest = (d.prepare('SELECT MIN(updated_at) as ts FROM sessions').get() as any).ts;
    const newest = (d.prepare('SELECT MAX(updated_at) as ts FROM sessions').get() as any).ts;
    const avgMsg = (d.prepare('SELECT AVG(message_count) as avg FROM sessions').get() as any).avg;
    return {
      total, cacheSize: memoryCache.size,
      oldestSession: oldest || null, newestSession: newest || null,
      avgMessageCount: Math.round((avgMsg || 0) * 10) / 10,
    };
  } catch {
    return { total: 0, cacheSize: memoryCache.size, oldestSession: null, newestSession: null, avgMessageCount: 0 };
  }
}

export function closeSessionDb(): void {
  if (db) { db.close(); db = null; }
  memoryCache.clear();
}
