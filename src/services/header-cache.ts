/*
 * File: header-cache.ts
 * Project: qwenproxy
 * Aggressive header caching with SQLite persistence
 */

import Database from 'better-sqlite3';
import path from 'path';

interface CachedHeaders {
  accountId: string;
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
  expiresAt: number;
  lastRefresh: number;
}

const DB_PATH = path.resolve('data', 'headers_cache.db');
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STALE_THRESHOLD_PCT = 0.2; // Refresh when 20% TTL remaining

export class HeaderCacheSQLite {
  private db: Database.Database | null = null;
  private memoryCache = new Map<string, CachedHeaders>();
  private refreshMutexes = new Map<string, Promise<any>>();
  private ttl: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttl = ttlMs;
    this.initDb();
    this.loadFromDb();
  }

  private initDb(): void {
    try {
      this.db = new Database(DB_PATH);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS headers_cache (
          account_id TEXT PRIMARY KEY,
          headers_json TEXT NOT NULL,
          chat_session_id TEXT,
          parent_message_id TEXT,
          expires_at INTEGER NOT NULL,
          last_refresh INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_headers_expires ON headers_cache(expires_at);
      `);
    } catch (err) {
      console.error('[HeaderCache] Failed to init DB:', (err as Error).message);
    }
  }

  private loadFromDb(): void {
    if (!this.db) return;
    try {
      const rows = this.db.prepare('SELECT * FROM headers_cache').all() as any[];
      for (const row of rows) {
        const cached: CachedHeaders = {
          accountId: row.account_id,
          headers: JSON.parse(row.headers_json),
          chatSessionId: row.chat_session_id || '',
          parentMessageId: row.parent_message_id || null,
          expiresAt: row.expires_at,
          lastRefresh: row.last_refresh,
        };
        this.memoryCache.set(row.account_id, cached);
      }
      console.log(`[HeaderCache] Loaded ${this.memoryCache.size} entries from DB`);
    } catch (err) {
      console.error('[HeaderCache] Failed to load from DB:', (err as Error).message);
    }
  }

  /**
   * Get cached headers for account
   */
  get(accountId: string): CachedHeaders | null {
    const cached = this.memoryCache.get(accountId);
    if (!cached) return null;
    return cached;
  }

  /**
   * Check if headers are stale (need refresh)
   */
  isStale(accountId: string): boolean {
    const cached = this.memoryCache.get(accountId);
    if (!cached) return true;

    const now = Date.now();
    if (now >= cached.expiresAt) return true;

    // Check if we're in the stale-while-revalidate window
    const remainingTTL = cached.expiresAt - now;
    const staleThreshold = this.ttl * STALE_THRESHOLD_PCT;
    return remainingTTL <= staleThreshold;
  }

  /**
   * Get headers with stale-while-revalidate support
   * Returns stale headers if refresh is in progress
   */
  getStaleWhileRevalidate(accountId: string): CachedHeaders | null {
    const cached = this.memoryCache.get(accountId);
    if (!cached) return null;

    const now = Date.now();

    // If not expired, return as-is
    if (now < cached.expiresAt) {
      return cached;
    }

    // If expired but refresh is in progress, return stale
    if (this.refreshMutexes.has(accountId)) {
      console.log(`[HeaderCache] Returning stale headers for ${accountId} (refresh in progress)`);
      return cached;
    }

    // Expired and no refresh in progress
    return null;
  }

  /**
   * Store headers in cache
   */
  set(
    accountId: string,
    headers: Record<string, string>,
    chatSessionId: string = '',
    parentMessageId: string | null = null,
    ttlMs?: number
  ): void {
    const now = Date.now();
    const effectiveTTL = ttlMs || this.ttl;

    const cached: CachedHeaders = {
      accountId,
      headers,
      chatSessionId,
      parentMessageId,
      expiresAt: now + effectiveTTL,
      lastRefresh: now,
    };

    this.memoryCache.set(accountId, cached);
    this.persistToDb(cached);

    console.log(`[HeaderCache] Stored headers for ${accountId}, expires in ${effectiveTTL / 1000}s`);
  }

  private persistToDb(cached: CachedHeaders): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO headers_cache 
        (account_id, headers_json, chat_session_id, parent_message_id, expires_at, last_refresh)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        cached.accountId,
        JSON.stringify(cached.headers),
        cached.chatSessionId,
        cached.parentMessageId,
        cached.expiresAt,
        cached.lastRefresh
      );
    } catch (err) {
      console.error('[HeaderCache] Failed to persist:', (err as Error).message);
    }
  }

  /**
   * Acquire mutex for refresh operation
   * Returns true if mutex acquired, false if another refresh is in progress
   */
  acquireRefreshMutex(accountId: string, refreshPromise: Promise<any>): boolean {
    if (this.refreshMutexes.has(accountId)) {
      return false;
    }

    this.refreshMutexes.set(
      accountId,
      refreshPromise.finally(() => {
        this.refreshMutexes.delete(accountId);
      })
    );

    return true;
  }

  /**
   * Check if refresh is in progress
   */
  isRefreshInProgress(accountId: string): boolean {
    return this.refreshMutexes.has(accountId);
  }

  /**
   * Delete cached headers for account
   */
  delete(accountId: string): void {
    this.memoryCache.delete(accountId);
    if (this.db) {
      try {
        this.db.prepare('DELETE FROM headers_cache WHERE account_id = ?').run(accountId);
      } catch (err) {
        console.error('[HeaderCache] Failed to delete:', (err as Error).message);
      }
    }
  }

  /**
   * Clear all cached headers
   */
  clear(): void {
    this.memoryCache.clear();
    if (this.db) {
      try {
        this.db.prepare('DELETE FROM headers_cache').run();
      } catch (err) {
        console.error('[HeaderCache] Failed to clear:', (err as Error).message);
      }
    }
  }

  /**
   * Get stats
   */
  getStats(): {
    size: number;
    stale: number;
    expired: number;
  } {
    const now = Date.now();
    let stale = 0;
    let expired = 0;

    for (const cached of this.memoryCache.values()) {
      if (now >= cached.expiresAt) {
        expired++;
      } else {
        const remaining = cached.expiresAt - now;
        if (remaining <= this.ttl * STALE_THRESHOLD_PCT) {
          stale++;
        }
      }
    }

    return {
      size: this.memoryCache.size,
      stale,
      expired,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.memoryCache.clear();
    this.refreshMutexes.clear();
  }
}

export const headerCache = new HeaderCacheSQLite();
