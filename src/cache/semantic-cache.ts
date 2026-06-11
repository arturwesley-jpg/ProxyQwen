/*
 * File: semantic-cache.ts
 * Project: qwenproxy
 * Semantic cache with SimHash for similar prompt matching
 */

import Database from 'better-sqlite3';
import path from 'path';
import { metrics } from '../core/metrics.js';

interface CacheEntry {
  hash: string;
  prompt: string;
  response: string;
  category: 'code' | 'fact' | 'creative';
  expiresAt: number;
  createdAt: number;
  accessCount: number;
  lastAccess: number;
}

const DB_PATH = path.resolve('data', 'semantic_cache.db');
const MAX_ENTRIES = 10000;
const CLEANUP_INTERVAL = 100;

// TTL in milliseconds
const TTL_MAP = {
  code: 60 * 60 * 1000,        // 1 hour
  fact: 24 * 60 * 60 * 1000,   // 24 hours
  creative: 0,                  // don't cache
};

// SimHash constants
const SIMHASH_BITS = 64;
const MAX_HAMMING_DISTANCE = 3;

/**
 * FNV-1a 64-bit hash implementation
 */
function fnv1a64(str: string): bigint {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;

  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash;
}

/**
 * Tokenize text into words (simple whitespace + punctuation split)
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

/**
 * Compute SimHash fingerprint (64-bit)
 */
function simhash(text: string): bigint {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0n;

  const vector = new Array<number>(SIMHASH_BITS).fill(0);

  for (const token of tokens) {
    const hash = fnv1a64(token);
    for (let i = 0; i < SIMHASH_BITS; i++) {
      const bit = (hash >> BigInt(i)) & 1n;
      vector[i] += bit === 1n ? 1 : -1;
    }
  }

  let fingerprint = 0n;
  for (let i = 0; i < SIMHASH_BITS; i++) {
    if (vector[i] > 0) {
      fingerprint |= 1n << BigInt(i);
    }
  }

  return fingerprint;
}

/**
 * Compute Hamming distance between two SimHash fingerprints
 */
function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let distance = 0;
  while (xor !== 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

/**
 * Classify prompt into category
 */
function classifyPrompt(prompt: string): 'code' | 'fact' | 'creative' {
  const lower = prompt.toLowerCase();

  // Code patterns
  if (/(\bcode\b|\bfunction\b|\bdef\s+\w+|\bclass\s+\w+|```|\bimport\s+|\bconst\s+|\blet\s+|\bvar\s+)/i.test(lower)) {
    return 'code';
  }

  // Creative patterns
  if (/(\bescreva\b|\bcrie\b|\bwrite\b|\bcreate\b|\bstory\b|\bpoem\b|\bpoema\b|\bhistória\b)/i.test(lower)) {
    return 'creative';
  }

  // Fact patterns (default)
  if (/(\bo que é\b|\bwho is\b|\bquando\b|\bwhat is\b|\bwhere\b|\bquando\b|\bcomo\b|\bpor que\b)/i.test(lower)) {
    return 'fact';
  }

  // Default to fact
  return 'fact';
}

export class SemanticCache {
  private db: Database.Database | null = null;
  private entries: Map<string, CacheEntry> = new Map();
  private storeCount = 0;

  constructor() {
    this.initDb();
    this.loadFromDb();
  }

  private initDb(): void {
    try {
      this.db = new Database(DB_PATH);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_cache (
          hash TEXT PRIMARY KEY,
          prompt TEXT NOT NULL,
          response TEXT NOT NULL,
          category TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          access_count INTEGER DEFAULT 0,
          last_access INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_semantic_cache_expires ON semantic_cache(expires_at);
        CREATE INDEX IF NOT EXISTS idx_semantic_cache_last_access ON semantic_cache(last_access);
      `);
    } catch (err) {
      console.error('[SemanticCache] Failed to init DB:', (err as Error).message);
    }
  }

  private loadFromDb(): void {
    if (!this.db) return;
    try {
      const rows = this.db.prepare('SELECT * FROM semantic_cache WHERE expires_at > ?').all(Date.now()) as CacheEntry[];
      for (const row of rows) {
        this.entries.set(row.hash, row);
      }
      console.log(`[SemanticCache] Loaded ${this.entries.size} entries from DB`);
    } catch (err) {
      console.error('[SemanticCache] Failed to load from DB:', (err as Error).message);
    }
  }

  /**
   * Lookup similar prompt in cache
   */
  lookup(prompt: string, maxDistance: number = MAX_HAMMING_DISTANCE): CacheEntry | null {
    const queryHash = simhash(prompt);

    let bestMatch: CacheEntry | null = null;
    let bestDistance = maxDistance + 1;

    for (const [hashStr, entry] of this.entries) {
      if (entry.expiresAt <= Date.now()) {
        continue;
      }

      const entryHash = BigInt('0x' + hashStr);
      const distance = hammingDistance(queryHash, entryHash);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = entry;
      }
    }

    if (bestMatch) {
      // Update access stats
      bestMatch.accessCount++;
      bestMatch.lastAccess = Date.now();
      this.updateAccessStats(bestMatch);
      metrics.increment('cache.semantic.hit');
      console.log(`[SemanticCache] Hit: distance=${bestDistance}, category=${bestMatch.category}`);
      return bestMatch;
    }

    metrics.increment('cache.semantic.miss');
    return null;
  }

  /**
   * Store prompt and response in cache
   */
  store(prompt: string, response: string, category?: 'code' | 'fact' | 'creative'): void {
    const detectedCategory = category || classifyPrompt(prompt);

    // Don't cache creative prompts
    if (detectedCategory === 'creative') {
      return;
    }

    const hash = simhash(prompt);
    const hashStr = hash.toString(16).padStart(16, '0');
    const now = Date.now();
    const ttl = TTL_MAP[detectedCategory];
    const expiresAt = now + ttl;

    const entry: CacheEntry = {
      hash: hashStr,
      prompt,
      response,
      category: detectedCategory,
      expiresAt,
      createdAt: now,
      accessCount: 0,
      lastAccess: now,
    };

    // Evict if at capacity
    if (this.entries.size >= MAX_ENTRIES) {
      this.evictLRU();
    }

    this.entries.set(hashStr, entry);
    this.persistToDb(entry);

    this.storeCount++;
    if (this.storeCount % CLEANUP_INTERVAL === 0) {
      this.cleanup();
    }

    metrics.increment('cache.semantic.stored');
    console.log(`[SemanticCache] Stored: ${hashStr.slice(0, 8)}..., category=${detectedCategory}, ttl=${ttl / 1000}s`);
  }

  private persistToDb(entry: CacheEntry): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO semantic_cache 
        (hash, prompt, response, category, expires_at, created_at, access_count, last_access)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.hash,
        entry.prompt,
        entry.response,
        entry.category,
        entry.expiresAt,
        entry.createdAt,
        entry.accessCount,
        entry.lastAccess
      );
    } catch (err) {
      console.error('[SemanticCache] Failed to persist:', (err as Error).message);
    }
  }

  private updateAccessStats(entry: CacheEntry): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        UPDATE semantic_cache 
        SET access_count = ?, last_access = ?
        WHERE hash = ?
      `).run(entry.accessCount, entry.lastAccess, entry.hash);
    } catch (err) {
      console.error('[SemanticCache] Failed to update stats:', (err as Error).message);
    }
  }

  private evictLRU(): void {
    let oldest: CacheEntry | null = null;
    for (const entry of this.entries.values()) {
      if (!oldest || entry.lastAccess < oldest.lastAccess) {
        oldest = entry;
      }
    }
    if (oldest) {
      this.entries.delete(oldest.hash);
      this.deleteFromDb(oldest.hash);
      metrics.increment('cache.semantic.evicted');
    }
  }

  private deleteFromDb(hash: string): void {
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM semantic_cache WHERE hash = ?').run(hash);
    } catch (err) {
      console.error('[SemanticCache] Failed to delete from DB:', (err as Error).message);
    }
  }

  private cleanup(): void {
    if (!this.db) return;
    const now = Date.now();
    try {
      // Remove expired from memory
      for (const [hash, entry] of this.entries) {
        if (entry.expiresAt <= now) {
          this.entries.delete(hash);
        }
      }
      // Remove expired from DB
      const result = this.db.prepare('DELETE FROM semantic_cache WHERE expires_at <= ?').run(now);
      console.log(`[SemanticCache] Cleanup: removed ${result.changes} expired entries`);
      metrics.increment('cache.semantic.cleanup', result.changes);
    } catch (err) {
      console.error('[SemanticCache] Cleanup failed:', (err as Error).message);
    }
  }

  getStats(): { size: number; hits: number; misses: number } {
    const hits = metrics.get('cache.semantic.hit')?.value || 0;
    const misses = metrics.get('cache.semantic.miss')?.value || 0;
    return {
      size: this.entries.size,
      hits: hits as number,
      misses: misses as number,
    };
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.entries.clear();
  }
}

export const semanticCache = new SemanticCache();
