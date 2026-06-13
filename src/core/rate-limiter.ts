/*
 * File: rate-limiter.ts
 * Project: qwenproxy
 * Token bucket rate limiter with per-account/tenant isolation
 *
 * Implements a token bucket algorithm for rate limiting with:
 * - Per-account (Qwen account) limits
 * - Per-tenant limits (for multi-tenancy)
 * - Configurable bucket sizes and refill rates
 * - Metrics integration for observability
 */

import { EventEmitter } from 'events';
import { config } from './config.js';
import { metrics } from './metrics.js';

export interface RateLimitConfig {
  /** Maximum tokens in the bucket (burst capacity) */
  capacity: number;
  /** Tokens added per second (sustained rate) */
  refillRate: number;
  /** Initial tokens (default: capacity) */
  initialTokens?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remainingTokens: number;
  retryAfterMs?: number;
  limit: number;
}

export interface RateLimiterStats {
  accountId?: string;
  tenantId?: string;
  currentTokens: number;
  capacity: number;
  refillRate: number;
  totalAllowed: number;
  totalRejected: number;
  lastRefill: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number;
  totalAllowed: number;
  totalRejected: number;
}

const DEFAULT_ACCOUNT_CONFIG: RateLimitConfig = {
  capacity: 10,        // 10 concurrent requests max per account
  refillRate: 2,       // 2 requests/second sustained
};

const DEFAULT_TENANT_CONFIG: RateLimitConfig = {
  capacity: 100,       // 100 concurrent requests per tenant
  refillRate: 20,      // 20 requests/second per tenant
};

const DEFAULT_GLOBAL_CONFIG: RateLimitConfig = {
  capacity: 500,       // 500 concurrent requests globally
  refillRate: 100,     // 100 requests/second globally
};

/**
 * Token bucket rate limiter with hierarchical limits:
 * Global -> Tenant -> Account
 */
export class RateLimiter extends EventEmitter {
  private accountBuckets = new Map<string, BucketState>();
  private tenantBuckets = new Map<string, BucketState>();
  private globalBucket: BucketState;
  private accountConfig: RateLimitConfig;
  private tenantConfig: RateLimitConfig;
  private globalConfig: RateLimitConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    accountConfig: Partial<RateLimitConfig> = {},
    tenantConfig: Partial<RateLimitConfig> = {},
    globalConfig: Partial<RateLimitConfig> = {}
  ) {
    super();

    this.accountConfig = { ...DEFAULT_ACCOUNT_CONFIG, ...accountConfig };
    this.tenantConfig = { ...DEFAULT_TENANT_CONFIG, ...tenantConfig };
    this.globalConfig = { ...DEFAULT_GLOBAL_CONFIG, ...globalConfig };

    this.globalBucket = this.createBucket(this.globalConfig);

    // Register metrics
    this.registerMetrics();

    // Start cleanup interval for stale buckets
    this.startCleanup();
  }

  private createBucket(cfg: RateLimitConfig): BucketState {
    return {
      tokens: cfg.initialTokens ?? cfg.capacity,
      lastRefill: Date.now(),
      totalAllowed: 0,
      totalRejected: 0,
    };
  }

  private registerMetrics(): void {
    // Metrics are registered in the global metrics instance
    // We just emit events that the metrics collector can pick up
  }

  private refillBucket(bucket: BucketState, config: RateLimitConfig): void {
    const now = Date.now();
    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = elapsedSeconds * config.refillRate;

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(config.capacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }
  }

  private tryConsume(bucket: BucketState, config: RateLimitConfig, tokens: number = 1): RateLimitResult {
    this.refillBucket(bucket, config);

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      bucket.totalAllowed++;
      return {
        allowed: true,
        remainingTokens: Math.floor(bucket.tokens),
        limit: config.capacity,
      };
    } else {
      bucket.totalRejected++;
      const retryAfterMs = Math.ceil(((tokens - bucket.tokens) / config.refillRate) * 1000);
      return {
        allowed: false,
        remainingTokens: 0,
        retryAfterMs,
        limit: config.capacity,
      };
    }
  }

  /**
   * Check and consume tokens from all applicable buckets (global -> tenant -> account)
   * Returns the first limiting result, or success if all pass
   */
  checkLimit(
    tokens: number = 1,
    accountId?: string,
    tenantId?: string
  ): RateLimitResult {
    // Check global limit first
    const globalResult = this.tryConsume(this.globalBucket, this.globalConfig, tokens);
    if (!globalResult.allowed) {
      metrics.increment('rate_limit.global_rejected', 1, { accountId: accountId || 'none', tenantId: tenantId || 'none' });
      this.emit('rejected', { level: 'global', ...globalResult, accountId, tenantId });
      return globalResult;
    }

    // Check tenant limit if provided
    if (tenantId) {
      let tenantBucket = this.tenantBuckets.get(tenantId);
      if (!tenantBucket) {
        tenantBucket = this.createBucket(this.tenantConfig);
        this.tenantBuckets.set(tenantId, tenantBucket);
      }

      const tenantResult = this.tryConsume(tenantBucket, this.tenantConfig, tokens);
      if (!tenantResult.allowed) {
        // Rollback global consumption
        this.globalBucket.tokens += tokens;
        this.globalBucket.totalAllowed--;

        metrics.increment('rate_limit.tenant_rejected', 1, { tenantId, accountId: accountId || 'none' });
        this.emit('rejected', { level: 'tenant', ...tenantResult, accountId, tenantId });
        return tenantResult;
      }
    }

    // Check account limit if provided
    if (accountId) {
      let accountBucket = this.accountBuckets.get(accountId);
      if (!accountBucket) {
        accountBucket = this.createBucket(this.accountConfig);
        this.accountBuckets.set(accountId, accountBucket);
      }

      const accountResult = this.tryConsume(accountBucket, this.accountConfig, tokens);
      if (!accountResult.allowed) {
        // Rollback global (and tenant) consumption
        this.globalBucket.tokens += tokens;
        this.globalBucket.totalAllowed--;

        if (tenantId) {
          const tenantBucket = this.tenantBuckets.get(tenantId);
          if (tenantBucket) {
            tenantBucket.tokens += tokens;
            tenantBucket.totalAllowed--;
          }
        }

        metrics.increment('rate_limit.account_rejected', 1, { accountId, tenantId: tenantId || 'none' });
        this.emit('rejected', { level: 'account', ...accountResult, accountId, tenantId });
        return accountResult;
      }
    }

    metrics.increment('rate_limit.allowed', 1, { accountId: accountId || 'none', tenantId: tenantId || 'none' });
    return {
      allowed: true,
      remainingTokens: accountId
        ? Math.floor(this.accountBuckets.get(accountId)?.tokens ?? this.accountConfig.capacity)
        : tenantId
        ? Math.floor(this.tenantBuckets.get(tenantId)?.tokens ?? this.tenantConfig.capacity)
        : Math.floor(this.globalBucket.tokens),
      limit: accountId ? this.accountConfig.capacity : tenantId ? this.tenantConfig.capacity : this.globalConfig.capacity,
    };
  }

  /**
   * Try to acquire tokens without blocking (non-blocking check)
   * Returns result without consuming tokens
   */
  peekLimit(
    tokens: number = 1,
    accountId?: string,
    tenantId?: string
  ): RateLimitResult {
    // Check global
    this.refillBucket(this.globalBucket, this.globalConfig);
    if (this.globalBucket.tokens < tokens) {
      return { allowed: false, remainingTokens: 0, retryAfterMs: Math.ceil(((tokens - this.globalBucket.tokens) / this.globalConfig.refillRate) * 1000), limit: this.globalConfig.capacity };
    }

    // Check tenant
    if (tenantId) {
      const tenantBucket = this.tenantBuckets.get(tenantId);
      if (tenantBucket) {
        this.refillBucket(tenantBucket, this.tenantConfig);
        if (tenantBucket.tokens < tokens) {
          return { allowed: false, remainingTokens: 0, retryAfterMs: Math.ceil(((tokens - tenantBucket.tokens) / this.tenantConfig.refillRate) * 1000), limit: this.tenantConfig.capacity };
        }
      }
    }

    // Check account
    if (accountId) {
      const accountBucket = this.accountBuckets.get(accountId);
      if (accountBucket) {
        this.refillBucket(accountBucket, this.accountConfig);
        if (accountBucket.tokens < tokens) {
          return { allowed: false, remainingTokens: 0, retryAfterMs: Math.ceil(((tokens - accountBucket.tokens) / this.accountConfig.refillRate) * 1000), limit: this.accountConfig.capacity };
        }
      }
    }

    return {
      allowed: true,
      remainingTokens: accountId
        ? Math.floor(this.accountBuckets.get(accountId)?.tokens ?? this.accountConfig.capacity)
        : tenantId
        ? Math.floor(this.tenantBuckets.get(tenantId)?.tokens ?? this.tenantConfig.capacity)
        : Math.floor(this.globalBucket.tokens),
      limit: accountId ? this.accountConfig.capacity : tenantId ? this.tenantConfig.capacity : this.globalConfig.capacity,
    };
  }

  /**
   * Get stats for a specific account
   */
  getAccountStats(accountId: string): RateLimiterStats | null {
    const bucket = this.accountBuckets.get(accountId);
    if (!bucket) return null;

    this.refillBucket(bucket, this.accountConfig);
    return {
      accountId,
      currentTokens: Math.floor(bucket.tokens),
      capacity: this.accountConfig.capacity,
      refillRate: this.accountConfig.refillRate,
      totalAllowed: bucket.totalAllowed,
      totalRejected: bucket.totalRejected,
      lastRefill: bucket.lastRefill,
    };
  }

  /**
   * Get stats for a specific tenant
   */
  getTenantStats(tenantId: string): RateLimiterStats | null {
    const bucket = this.tenantBuckets.get(tenantId);
    if (!bucket) return null;

    this.refillBucket(bucket, this.tenantConfig);
    return {
      tenantId,
      currentTokens: Math.floor(bucket.tokens),
      capacity: this.tenantConfig.capacity,
      refillRate: this.tenantConfig.refillRate,
      totalAllowed: bucket.totalAllowed,
      totalRejected: bucket.totalRejected,
      lastRefill: bucket.lastRefill,
    };
  }

  /**
   * Get global stats
   */
  getGlobalStats(): RateLimiterStats {
    this.refillBucket(this.globalBucket, this.globalConfig);
    return {
      currentTokens: Math.floor(this.globalBucket.tokens),
      capacity: this.globalConfig.capacity,
      refillRate: this.globalConfig.refillRate,
      totalAllowed: this.globalBucket.totalAllowed,
      totalRejected: this.globalBucket.totalRejected,
      lastRefill: this.globalBucket.lastRefill,
    };
  }

  /**
   * Get all account stats (for monitoring)
   */
  getAllAccountStats(): RateLimiterStats[] {
    const stats: RateLimiterStats[] = [];
    for (const [accountId, bucket] of this.accountBuckets.entries()) {
      this.refillBucket(bucket, this.accountConfig);
      stats.push({
        accountId,
        currentTokens: Math.floor(bucket.tokens),
        capacity: this.accountConfig.capacity,
        refillRate: this.accountConfig.refillRate,
        totalAllowed: bucket.totalAllowed,
        totalRejected: bucket.totalRejected,
        lastRefill: bucket.lastRefill,
      });
    }
    return stats;
  }

  /**
   * Get all tenant stats
   */
  getAllTenantStats(): RateLimiterStats[] {
    const stats: RateLimiterStats[] = [];
    for (const [tenantId, bucket] of this.tenantBuckets.entries()) {
      this.refillBucket(bucket, this.tenantConfig);
      stats.push({
        tenantId,
        currentTokens: Math.floor(bucket.tokens),
        capacity: this.tenantConfig.capacity,
        refillRate: this.tenantConfig.refillRate,
        totalAllowed: bucket.totalAllowed,
        totalRejected: bucket.totalRejected,
        lastRefill: bucket.lastRefill,
      });
    }
    return stats;
  }

  /**
   * Reset a specific account's bucket (e.g., after cooldown)
   */
  resetAccount(accountId: string): boolean {
    const bucket = this.accountBuckets.get(accountId);
    if (bucket) {
      bucket.tokens = this.accountConfig.capacity;
      bucket.lastRefill = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Reset a specific tenant's bucket
   */
  resetTenant(tenantId: string): boolean {
    const bucket = this.tenantBuckets.get(tenantId);
    if (bucket) {
      bucket.tokens = this.tenantConfig.capacity;
      bucket.lastRefill = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Reset global bucket
   */
  resetGlobal(): void {
    this.globalBucket.tokens = this.globalConfig.capacity;
    this.globalBucket.lastRefill = Date.now();
  }

  /**
   * Remove stale buckets (not accessed recently)
   */
  private cleanupStaleBuckets(maxAgeMs: number = 5 * 60 * 1000): { accounts: number; tenants: number } {
    const now = Date.now();
    let accountsRemoved = 0;
    let tenantsRemoved = 0;

    for (const [accountId, bucket] of this.accountBuckets.entries()) {
      if (now - bucket.lastRefill > maxAgeMs && bucket.tokens >= this.accountConfig.capacity) {
        this.accountBuckets.delete(accountId);
        accountsRemoved++;
      }
    }

    for (const [tenantId, bucket] of this.tenantBuckets.entries()) {
      if (now - bucket.lastRefill > maxAgeMs && bucket.tokens >= this.tenantConfig.capacity) {
        this.tenantBuckets.delete(tenantId);
        tenantsRemoved++;
      }
    }

    return { accounts: accountsRemoved, tenants: tenantsRemoved };
  }

  private startCleanup(): void {
    // Cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const removed = this.cleanupStaleBuckets();
      if (removed.accounts > 0 || removed.tenants > 0) {
        console.log(`[RateLimiter] Cleaned up ${removed.accounts} account buckets, ${removed.tenants} tenant buckets`);
      }
    }, 5 * 60 * 1000);

    // Don't prevent process exit
    this.cleanupInterval.unref?.();
  }

  /**
   * Stop cleanup interval and clear all buckets
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.accountBuckets.clear();
    this.tenantBuckets.clear();
    this.resetGlobal();
  }
}

/**
 * Create rate limiter from environment configuration
 */
export function createRateLimiterFromEnv(): RateLimiter {
  return new RateLimiter(
    {
      capacity: parseInt(process.env.RATE_LIMIT_ACCOUNT_CAPACITY || '10'),
      refillRate: parseFloat(process.env.RATE_LIMIT_ACCOUNT_REFILL || '2'),
    },
    {
      capacity: parseInt(process.env.RATE_LIMIT_TENANT_CAPACITY || '100'),
      refillRate: parseFloat(process.env.RATE_LIMIT_TENANT_REFILL || '20'),
    },
    {
      capacity: parseInt(process.env.RATE_LIMIT_GLOBAL_CAPACITY || '500'),
      refillRate: parseFloat(process.env.RATE_LIMIT_GLOBAL_REFILL || '100'),
    }
  );
}

// Singleton instance
export const rateLimiter = createRateLimiterFromEnv();