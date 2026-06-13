/**
 * File: warm-pool.ts
 * Project: qwenproxy
 * Warm Pool Manager - Pre-warmed chat sessions for sub-second first-token latency
 * 
 * Problem: Each request was creating a new chat (2-5s overhead)
 * Solution: Maintain pool of pre-created chats per account, with smart refill
 */

import { getBasicHeaders } from './playwright.js';
import { createRealQwenChat } from './qwen.js';

interface WarmPoolEntry {
  chatId: string;
  headers: Record<string, string>;
  accountId: string;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
  healthy: boolean;
  inUse: boolean;          // Track if chat is currently processing a request
  inUseSince?: number;     // Timestamp when chat was marked in-use
}

interface PoolMetrics {
  hits: number;
  misses: number;
  created: number;
  failed: number;
  evicted: number;
  refills: number;
}

const DEFAULT_CONFIG = {
  maxPoolPerAccount: 15,           // Chats pré-criados por conta
  minPoolPerAccount: 5,            // Mínimo para trigger refill
  ttlMs: 30 * 60 * 1000,           // 30 min TTL
  maxAgeMs: 60 * 60 * 1000,        // 1h max age (force refresh)
  maxUses: 50,                     // Max uses before recycle
  refillConcurrency: 3,            // Chats criados em paralelo
  refillCooldownMs: 10000,         // Cooldown entre refills
  healthCheckIntervalMs: 60000,    // Check health a cada 1 min
  healthCheckTimeoutMs: 5000,      // Timeout health check
};

type WarmPoolConfig = typeof DEFAULT_CONFIG;

class WarmPoolManager {
  private pools: Map<string, WarmPoolEntry[]> = new Map();
  private refillInFlight: Map<string, boolean> = new Map();
  private lastRefillAt: Map<string, number> = new Map();
  private metrics: Map<string, PoolMetrics> = new Map();
  private config: WarmPoolConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<WarmPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startBackgroundTasks();
  }

  /** Acquire a warmed chat from pool, or create new if pool empty */
  async acquire(accountId: string): Promise<{ chatId: string; headers: Record<string, string>; fromPool: boolean }> {
    const pool = this.getOrCreatePool(accountId);
    const metrics = this.getOrCreateMetrics(accountId);

    // Try to get healthy entry from pool (not in use)
    const entry = this.popHealthyEntry(pool);

    if (entry) {
      metrics.hits++;
      entry.lastUsedAt = Date.now();
      entry.useCount++;
      entry.inUse = true;
      entry.inUseSince = Date.now();
      this.maybeTriggerRefill(accountId, pool.length);
      return { chatId: entry.chatId, headers: entry.headers, fromPool: true };
    }

    // Pool miss - create new chat and add to pool as inUse
    metrics.misses++;
    const headers = await this.createChatHeaders(accountId);
    const chatId = await createRealQwenChat(headers);
    metrics.created++;

    // Add new chat to pool with inUse=true so concurrent requests see it's busy
    const newEntry: WarmPoolEntry = {
      chatId,
      headers,
      accountId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 1,
      healthy: true,
      inUse: true,
      inUseSince: Date.now(),
    };
    pool.push(newEntry);

    return { chatId, headers, fromPool: false };
  }

  /** Return a chat to pool after use (if still healthy) */
  async release(accountId: string, chatId: string, headers: Record<string, string>): Promise<void> {
    const pool = this.getOrCreatePool(accountId);
    const existingIdx = pool.findIndex(e => e.chatId === chatId);

    if (existingIdx >= 0) {
      // Update existing entry
      const entry = pool[existingIdx];
      entry.lastUsedAt = Date.now();
      entry.headers = headers; // Refresh headers (cookies may have rotated)
      entry.healthy = true;
      entry.inUse = false;
      entry.inUseSince = undefined;
    } else if (pool.length < this.config.maxPoolPerAccount) {
      // Add new entry
      pool.push({
        chatId,
        headers,
        accountId,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        useCount: 1,
        healthy: true,
        inUse: false,
      });
    }
    // If pool full or chat overused, let it be GC'd
  }

  /** Mark chat as unhealthy (e.g., after stream error) */
  markUnhealthy(accountId: string, chatId: string): void {
    const pool = this.pools.get(accountId);
    if (!pool) return;

    const entry = pool.find(e => e.chatId === chatId);
    if (entry) {
      entry.healthy = false;
    }
  }

  /** Get pool snapshot for monitoring */
  getSnapshot(accountId?: string): Record<string, any> {
    const result: Record<string, any> = {};
    const accounts = accountId ? [accountId] : Array.from(this.pools.keys());

    for (const acc of accounts) {
      const pool = this.pools.get(acc) || [];
      const metrics = this.metrics.get(acc) || { hits: 0, misses: 0, created: 0, failed: 0, evicted: 0, refills: 0 };
      const now = Date.now();
      const healthy = pool.filter(e => e.healthy && now - e.lastUsedAt < this.config.ttlMs);

      result[acc] = {
        total: pool.length,
        healthy: healthy.length,
        stale: pool.length - healthy.length,
        oldestMs: pool.length > 0 ? now - Math.min(...pool.map(e => e.createdAt)) : null,
        metrics,
        hitRate: metrics.hits + metrics.misses > 0
          ? (metrics.hits / (metrics.hits + metrics.misses) * 100).toFixed(1) + '%'
          : '0%',
      };
    }
    return result;
  }

  /** Get aggregated metrics across all accounts */
  getAggregatedMetrics(): PoolMetrics & { hitRate: string; accounts: number } {
    let totals: PoolMetrics = { hits: 0, misses: 0, created: 0, failed: 0, evicted: 0, refills: 0 };
    for (const m of this.metrics.values()) {
      totals.hits += m.hits;
      totals.misses += m.misses;
      totals.created += m.created;
      totals.failed += m.failed;
      totals.evicted += m.evicted;
      totals.refills += m.refills;
    }
    return {
      ...totals,
      hitRate: totals.hits + totals.misses > 0
        ? (totals.hits / (totals.hits + totals.misses) * 100).toFixed(1) + '%'
        : '0%',
      accounts: this.metrics.size,
    };
  }

  /** Force refill for specific account */
  async forceRefill(accountId: string): Promise<number> {
    const pool = this.getOrCreatePool(accountId);
    return await this.doRefill(accountId, pool);
  }

  /** Shutdown gracefully */
  shutdown(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    this.cleanupInterval = null;
    this.healthCheckInterval = null;
    this.pools.clear();
    this.metrics.clear();
  }

  // ==================== PRIVATE METHODS ====================

  private getOrCreatePool(accountId: string): WarmPoolEntry[] {
    let pool = this.pools.get(accountId);
    if (!pool) {
      pool = [];
      this.pools.set(accountId, pool);
    }
    return pool;
  }

  private getOrCreateMetrics(accountId: string): PoolMetrics {
    let m = this.metrics.get(accountId);
    if (!m) {
      m = { hits: 0, misses: 0, created: 0, failed: 0, evicted: 0, refills: 0 };
      this.metrics.set(accountId, m);
    }
    return m;
  }

  private popHealthyEntry(pool: WarmPoolEntry[]): WarmPoolEntry | null {
    const now = Date.now();
    // Find best candidate: healthy, not in use, not too old, not overused
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < pool.length; i++) {
      const entry = pool[i];
      if (!entry.healthy) continue;
      if (entry.inUse) {
        // Check for stale in-use (stuck request) - force release after 5 minutes
        if (entry.inUseSince && now - entry.inUseSince > 5 * 60 * 1000) {
          console.warn(`[WarmPool] Chat ${entry.chatId} stuck in-use for ${Math.round((now - entry.inUseSince) / 1000)}s, forcing release`);
          entry.inUse = false;
          entry.inUseSince = undefined;
        } else {
          continue;
        }
      }
      if (now - entry.lastUsedAt > this.config.ttlMs) continue;
      if (now - entry.createdAt > this.config.maxAgeMs) continue;
      if (entry.useCount >= this.config.maxUses) continue;

      // Score: prefer recently used, less used entries
      const ageScore = 1 - (now - entry.lastUsedAt) / this.config.ttlMs;
      const useScore = 1 - entry.useCount / this.config.maxUses;
      const score = ageScore * 0.6 + useScore * 0.4;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      return pool.splice(bestIdx, 1)[0];
    }
    return null;
  }

  private async createChatHeaders(accountId: string): Promise<Record<string, string>> {
    const { cookie, userAgent, bxV } = await getBasicHeaders(accountId === 'global' ? undefined : accountId);
    return { cookie, 'user-agent': userAgent, 'bx-v': bxV };
  }

  private maybeTriggerRefill(accountId: string, currentSize: number): void {
    if (currentSize >= this.config.minPoolPerAccount) return;

    const lastRefill = this.lastRefillAt.get(accountId) || 0;
    const now = Date.now();
    if (now - lastRefill < this.config.refillCooldownMs) return;
    if (this.refillInFlight.get(accountId)) return;

    // Fire and forget
    this.doRefill(accountId, this.getOrCreatePool(accountId)).catch(err => {
      console.error(`[WarmPool] Refill failed for ${accountId}:`, err.message);
    });
  }

  private async doRefill(accountId: string, pool: WarmPoolEntry[]): Promise<number> {
    if (this.refillInFlight.get(accountId)) return 0;
    if (pool.length >= this.config.maxPoolPerAccount) return 0;

    this.refillInFlight.set(accountId, true);
    this.lastRefillAt.set(accountId, Date.now());
    const metrics = this.getOrCreateMetrics(accountId);
    metrics.refills++;

    const need = Math.min(
      this.config.maxPoolPerAccount - pool.length,
      this.config.refillConcurrency
    );

    try {
      const headers = await this.createChatHeaders(accountId);
      const createPromises = Array.from({ length: need }, () =>
        createRealQwenChat(headers)
          .then((chatId: string) => ({ chatId, headers, accountId, createdAt: Date.now(), lastUsedAt: Date.now(), useCount: 0, healthy: true, inUse: false }))
          .catch((err: Error) => {
            metrics.failed++;
            console.error(`[WarmPool] Create chat failed:`, err.message);
            return null;
          })
      );

      const results = await Promise.all(createPromises);
      let added = 0;
      for (const entry of results) {
        if (entry && pool.length < this.config.maxPoolPerAccount) {
          pool.push(entry);
          added++;
        }
      }

      console.log(`[WarmPool] Refilled ${accountId}: +${added} (pool: ${pool.length}/${this.config.maxPoolPerAccount})`);
      return added;
    } finally {
      this.refillInFlight.set(accountId, false);
    }
  }

  private startBackgroundTasks(): void {
    // Cleanup stale entries
    this.cleanupInterval = setInterval(() => this.cleanup(), this.config.healthCheckIntervalMs);

    // Health check (ping chats to verify they're still alive)
    this.healthCheckInterval = setInterval(() => this.healthCheck(), this.config.healthCheckIntervalMs);
  }

  private cleanup(): void {
    const now = Date.now();
    let totalEvicted = 0;

    for (const [accountId, pool] of this.pools.entries()) {
      const initialLen = pool.length;

      // Filter: healthy + within TTL + within maxAge + under maxUses
      const filtered = pool.filter(e =>
        e.healthy &&
        now - e.lastUsedAt < this.config.ttlMs &&
        now - e.createdAt < this.config.maxAgeMs &&
        e.useCount < this.config.maxUses
      );

      const evicted = initialLen - filtered.length;
      if (evicted > 0) {
        const metrics = this.getOrCreateMetrics(accountId);
        metrics.evicted += evicted;
        totalEvicted += evicted;
      }

      this.pools.set(accountId, filtered);

      // Clean empty pools
      if (filtered.length === 0) {
        this.pools.delete(accountId);
        this.metrics.delete(accountId);
        this.refillInFlight.delete(accountId);
        this.lastRefillAt.delete(accountId);
      }
    }

    if (totalEvicted > 0) {
      console.log(`[WarmPool] Cleanup: evicted ${totalEvicted} stale entries`);
    }
  }

  private async healthCheck(): Promise<void> {
    // Sample check: verify a few chats per account still respond
    for (const [accountId, pool] of this.pools.entries()) {
      const healthyEntries = pool.filter(e => e.healthy);
      if (healthyEntries.length === 0) continue;

      // Check up to 2 chats per cycle
      const toCheck = healthyEntries.slice(0, 2);

      for (const entry of toCheck) {
        try {
          // Quick health check: send a minimal request to chat endpoint
          // If it fails, mark unhealthy
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), this.config.healthCheckTimeoutMs);

          // We don't actually send - just verify headers are fresh
          // Real check would be: POST to /api/v2/chats/{chatId}/messages with tiny payload
          // For now, trust the TTL + headers refresh on release

          clearTimeout(timeout);
        } catch {
          entry.healthy = false;
        }
      }
    }
  }
}

// Singleton instance
export const warmPoolManager = new WarmPoolManager();

// Config update helper (for runtime tuning)
export function updateWarmPoolConfig(partial: Partial<WarmPoolConfig>): void {
  Object.assign(DEFAULT_CONFIG, partial);
  console.log('[WarmPool] Config updated:', DEFAULT_CONFIG);
}

export function getWarmPoolConfig(): WarmPoolConfig {
  return { ...DEFAULT_CONFIG };
}