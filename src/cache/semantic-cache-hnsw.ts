/**
 * File: semantic-cache-hnsw.ts
 * Project: qwenproxy
 * Semantic Cache with HNSW (Hierarchical Navigable Small World) for O(log n) similarity search
 * Replaces O(n) linear scan with approximate nearest neighbor search
 */

import Database from 'better-sqlite3';
import path from 'path';
import { metrics } from '../core/metrics.js';
import hnswlib from 'hnswlib-node';

const { HierarchicalNSW } = hnswlib;

export interface CacheEntry {
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

const TTL_MAP = {
  code: 60 * 60 * 1000,        // 1 hour
  fact: 24 * 60 * 60 * 1000,   // 24 hours
  creative: 0,                  // don't cache
};

const SIMHASH_BITS = 64;
const MAX_HAMMING_DISTANCE = 3;

// HNSW Configuration
const HNSW_DIM = 64;           // simhash fingerprint size
const HNSW_M = 16;             // connections per node
const HNSW_EF_CONSTRUCTION = 200;
const HNSW_EF_SEARCH = 50;

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
 * Compute SimHash fingerprint (64-bit) - returns Float32Array for HNSW
 */
function simhashVector(text: string): Float32Array {
  const tokens = tokenize(text);
  if (tokens.length === 0) return new Float32Array(HNSW_DIM);

  const vector = new Array<number>(SIMHASH_BITS).fill(0);

  for (const token of tokens) {
    const hash = fnv1a64(token);
    for (let i = 0; i < SIMHASH_BITS; i++) {
      const bit = (hash >> BigInt(i)) & 1n;
      vector[i] += bit === 1n ? 1 : -1;
    }
  }

  // Convert to unit vector for L2 distance
  const result = new Float32Array(HNSW_DIM);
  for (let i = 0; i < HNSW_DIM; i++) {
    result[i] = vector[i] > 0 ? 1.0 : -1.0;
  }
  
  // Normalize for L2 distance
  let norm = 0;
  for (let i = 0; i < HNSW_DIM; i++) {
    norm += result[i] * result[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < HNSW_DIM; i++) {
    result[i] /= norm;
  }
  
  return result;
}

/**
 * Compute Hamming distance between two SimHash fingerprints (for verification)
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

function classifyPrompt(prompt: string): 'code' | 'fact' | 'creative' {
  const lower = prompt.toLowerCase();

  if (/(\bcode\b|\bfunction\b|\bdef\s+\w+|\bclass\s+\w+|```|\bimport\s+|\bconst\s+|\blet\s+|\bvar\s+)/i.test(lower)) {
    return 'code';
  }

  if (/(\bescreva\b|\bcrie\b|\bwrite\b|\bcreate\b|\bstory\b|\bpoem\b|\bpoema\b|\bhistória\b)/i.test(lower)) {
    return 'creative';
  }

  if (/(\bo que é\b|\bwho is\b|\bquando\b|\bwhat is\b|\bwhere\b|\bquando\b|\bcomo\b|\bpor que\b)/i.test(lower)) {
    return 'fact';
  }

  return 'fact';
}

export class SemanticCacheHNSW {
  private db: Database.Database | null = null;
  private entries: Map<string, CacheEntry> = new Map();
  private storeCount = 0;
  
  // HNSW index
  private hnswIndex: any = null;
  private indexEntries: Map<number, string> = new Map(); // HNSW label -> hash
  private nextLabel = 0;
  private indexDirty = false;

  constructor() {
    this.initDb();
    this.initHNSW();
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
      console.error('[SemanticCacheHNSW] Failed to init DB:', (err as Error).message);
    }
  }

  private initHNSW(): void {
    try {
      // Initialize empty HNSW index using HierarchicalNSW
      // 'l2' = Euclidean distance, 'ip' = inner product (cosine when normalized)
      this.hnswIndex = new HierarchicalNSW('l2', HNSW_DIM);
      this.hnswIndex.initIndex(MAX_ENTRIES, HNSW_M, HNSW_EF_CONSTRUCTION);
      this.hnswIndex.setEf(HNSW_EF_SEARCH);
      console.log('[SemanticCacheHNSW] HNSW index initialized');
    } catch (err) {
      console.error('[SemanticCacheHNSW] Failed to init HNSW:', (err as Error).message);
    }
  }

  private loadFromDb(): void {
    if (!this.db || !this.hnswIndex) return;
    try {
      const rows = this.db.prepare('SELECT * FROM semantic_cache WHERE expires_at > ?').all(Date.now()) as CacheEntry[];
      for (const row of rows) {
        this.entries.set(row.hash, row);
        // Add to HNSW index
        this.addToHNSW(row);
      }
      console.log(`[SemanticCacheHNSW] Loaded ${this.entries.size} entries from DB into HNSW`);
    } catch (err) {
      console.error('[SemanticCacheHNSW] Failed to load from DB:', (err as Error).message);
    }
  }

  private addToHNSW(entry: CacheEntry): void {
    if (!this.hnswIndex) return;
    
    try {
      const vector = Array.from(simhashVector(entry.prompt)); // Convert to plain array
      const label = this.nextLabel++;
      this.hnswIndex.addPoint(vector, label);
      this.indexEntries.set(label, entry.hash);
    } catch (err) {
      console.error('[SemanticCacheHNSW] Failed to add to HNSW:', (err as Error).message);
    }
  }

  private removeFromHNSW(hash: string): boolean {
    if (!this.hnswIndex) return false;
    
    // HNSW doesn't support true deletion, mark as deleted by re-adding with far vector
    // Or rebuild index periodically. For now, we'll leave stale entries.
    // The lookup will verify against the actual entries Map.
    // This is acceptable since we verify with full simhash distance check.
    this.indexDirty = true;
    return true;
  }

  /**
   * Lookup similar prompt in cache using HNSW (O(log n))
   */
  lookup(prompt: string, maxDistance: number = MAX_HAMMING_DISTANCE): CacheEntry | null {
    if (!this.hnswIndex || this.entries.size === 0) {
      metrics.increment('cache.semantic.miss');
      return null;
    }

    const queryVector = Array.from(simhashVector(prompt));
    
    try {
      // Search HNSW for nearest neighbors
      const result = this.hnswIndex.searchKnn(queryVector, 10); // Get top 10
      
      let bestMatch: CacheEntry | null = null;
      let bestDistance = maxDistance + 1;

      for (const label of result.neighbors) {
        const hash = this.indexEntries.get(label);
        if (!hash) continue;
        
        const entry = this.entries.get(hash);
        if (!entry) continue;
        
        if (entry.expiresAt <= Date.now()) continue;

        // Compute exact Hamming distance for verification
        const entryHash = BigInt('0x' + hash);
        const queryHash = this.computeSimHashBigInt(prompt);
        const distance = hammingDistance(queryHash, entryHash);

        if (distance < bestDistance) {
          bestDistance = distance;
          bestMatch = entry;
        }
      }

      if (bestMatch && bestDistance <= maxDistance) {
        bestMatch.accessCount++;
        bestMatch.lastAccess = Date.now();
        this.updateAccessStats(bestMatch);
        metrics.increment('cache.semantic.hit');
        console.log(`[SemanticCacheHNSW] Hit: distance=${bestDistance}, category=${bestMatch.category}, candidates=${result.neighbors.length}`);
        return bestMatch;
      }
    } catch (err) {
      console.error('[SemanticCacheHNSW] Lookup error:', (err as Error).message);
    }

    metrics.increment('cache.semantic.miss');
    return null;
  }

  private computeSimHashBigInt(text: string): bigint {
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
   * Store prompt and response in cache
   */
  store(prompt: string, response: string, category?: 'code' | 'fact' | 'creative'): void {
    const detectedCategory = category || classifyPrompt(prompt);

    if (detectedCategory === 'creative') {
      return;
    }

    const hash = this.computeSimHashBigInt(prompt);
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

    if (this.entries.size >= MAX_ENTRIES) {
      this.evictLRU();
    }

    this.entries.set(hashStr, entry);
    this.addToHNSW(entry);
    this.persistToDb(entry);

    this.storeCount++;
    if (this.storeCount % CLEANUP_INTERVAL === 0) {
      this.cleanup();
    }

    metrics.increment('cache.semantic.stored');
    console.log(`[SemanticCacheHNSW] Stored: ${hashStr.slice(0, 8)}..., category=${detectedCategory}, ttl=${ttl / 1000}s, index_size=${this.entries.size}`);
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
      console.error('[SemanticCacheHNSW] Failed to persist:', (err as Error).message);
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
      console.error('[SemanticCacheHNSW] Failed to update stats:', (err as Error).message);
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
      this.removeFromHNSW(oldest.hash);
      this.deleteFromDb(oldest.hash);
      metrics.increment('cache.semantic.evicted');
    }
  }

  private deleteFromDb(hash: string): void {
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM semantic_cache WHERE hash = ?').run(hash);
    } catch (err) {
      console.error('[SemanticCacheHNSW] Failed to delete from DB:', (err as Error).message);
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
          this.removeFromHNSW(hash);
        }
      }
      // Remove expired from DB
      const result = this.db.prepare('DELETE FROM semantic_cache WHERE expires_at <= ?').run(now);
      console.log(`[SemanticCacheHNSW] Cleanup: removed ${result.changes} expired entries, index_size=${this.entries.size}`);
      metrics.increment('cache.semantic.cleanup', result.changes);
    } catch (err) {
      console.error('[SemanticCacheHNSW] Cleanup failed:', (err as Error).message);
    }
  }

  getStats(): { size: number; hits: number; misses: number; indexSize: number } {
    const hits = metrics.get('cache.semantic.hit')?.value || 0;
    const misses = metrics.get('cache.semantic.miss')?.value || 0;
    return {
      size: this.entries.size,
      hits: hits as number,
      misses: misses as number,
      indexSize: this.indexEntries.size,
    };
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.entries.clear();
    this.indexEntries.clear();
    this.hnswIndex = null;
  }

  /**
   * Rebuild HNSW index from current entries (call periodically)
   */
  rebuildIndex(): void {
    if (!this.hnswIndex) return;
    
    console.log('[SemanticCacheHNSW] Rebuilding HNSW index...');
    this.hnswIndex = new HierarchicalNSW('l2', HNSW_DIM);
    this.hnswIndex.initIndex(MAX_ENTRIES, HNSW_M, HNSW_EF_CONSTRUCTION);
    this.hnswIndex.setEf(HNSW_EF_SEARCH);
    this.indexEntries.clear();
    this.nextLabel = 0;

    for (const entry of this.entries.values()) {
      this.addToHNSW(entry);
    }
    
    this.indexDirty = false;
    console.log('[SemanticCacheHNSW] Index rebuilt:', { entries: this.entries.size, indexSize: this.indexEntries.size });
  }
}

export const semanticCacheHNSW = new SemanticCacheHNSW();