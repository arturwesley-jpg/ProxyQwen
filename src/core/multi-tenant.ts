/*
 * File: multi-tenant.ts
 * Project: qwenproxy
 * Multi-tenant isolation with resource limits and accounting
 */

import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';

const DB_PATH = path.resolve('data', 'tenants.db');

export interface Tenant {
  id: string;
  name: string;
  apiKey: string;
  createdAt: number;
  status: 'active' | 'suspended' | 'deleted';
  limits: TenantLimits;
  usage: TenantUsage;
}

export interface TenantLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
  maxTokensPerRequest: number;
  maxConcurrentStreams: number;
  allowedModels: string[]; // Empty = all allowed
  allowedAccounts: string[]; // Empty = all allowed
}

export interface TenantUsage {
  requestsToday: number;
  requestsThisMinute: number;
  tokensToday: number;
  activeStreams: number;
  lastRequestAt: number;
}

export interface TenantRequest {
  tenantId: string;
  requestId: string;
  model: string;
  tokens: number;
  latencyMs: number;
  timestamp: number;
  success: boolean;
}

const DEFAULT_LIMITS: TenantLimits = {
  requestsPerMinute: 60,
  requestsPerDay: 10000,
  maxTokensPerRequest: 100000,
  maxConcurrentStreams: 10,
  allowedModels: [],
  allowedAccounts: [],
};

let db: Database.Database | null = null;
const tenantCache = new Map<string, Tenant>();
const requestCounters = new Map<string, { minute: number; day: number; lastReset: number }>();

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        limits_json TEXT NOT NULL,
        usage_json TEXT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS tenant_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        success INTEGER NOT NULL,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_tenants_api_key ON tenants(api_key);
      CREATE INDEX IF NOT EXISTS idx_requests_tenant ON tenant_requests(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON tenant_requests(timestamp);
    `);
    
    loadTenants();
  }
  return db;
}

/**
 * Load all active tenants into cache
 */
function loadTenants(): void {
  try {
    const rows = getDb().prepare('SELECT * FROM tenants WHERE status != ?').all('deleted') as any[];
    for (const row of rows) {
      tenantCache.set(row.api_key, {
        id: row.id,
        name: row.name,
        apiKey: row.api_key,
        createdAt: row.created_at,
        status: row.status,
        limits: JSON.parse(row.limits_json),
        usage: JSON.parse(row.usage_json),
      });
    }
    console.log(`[MultiTenant] Loaded ${tenantCache.size} active tenants`);
  } catch (err: any) {
    console.error('[MultiTenant] Failed to load tenants:', err.message);
  }
}

/**
 * Create new tenant
 */
export function createTenant(
  name: string,
  limits: Partial<TenantLimits> = {}
): Tenant {
  const id = `tenant_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const apiKey = `sk-${crypto.randomBytes(32).toString('hex')}`;
  
  const tenant: Tenant = {
    id,
    name,
    apiKey,
    createdAt: Date.now(),
    status: 'active',
    limits: { ...DEFAULT_LIMITS, ...limits },
    usage: {
      requestsToday: 0,
      requestsThisMinute: 0,
      tokensToday: 0,
      activeStreams: 0,
      lastRequestAt: 0,
    },
  };

  try {
    getDb().prepare(`
      INSERT INTO tenants 
      (id, name, api_key, created_at, status, limits_json, usage_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      apiKey,
      tenant.createdAt,
      'active',
      JSON.stringify(tenant.limits),
      JSON.stringify(tenant.usage)
    );

    tenantCache.set(apiKey, tenant);
    console.log(`[MultiTenant] Created tenant: ${name} (${id})`);
    
    return tenant;
  } catch (err: any) {
    throw new Error(`Failed to create tenant: ${err.message}`);
  }
}

/**
 * Authenticate tenant by API key
 */
export function authenticateTenant(apiKey: string): Tenant | null {
  const tenant = tenantCache.get(apiKey);
  if (!tenant || tenant.status !== 'active') {
    return null;
  }
  return tenant;
}

/**
 * Check if tenant can make request (rate limits)
 */
export function canMakeRequest(tenant: Tenant): { allowed: boolean; reason?: string } {
  const now = Date.now();
  const counters = getOrInitCounters(tenant.id);

  // Reset counters if needed
  const minuteAgo = now - 60000;
  const dayAgo = now - 86400000;

  if (counters.lastReset < minuteAgo) {
    counters.minute = 0;
    counters.lastReset = now;
  }

  // Check per-minute limit
  if (counters.minute >= tenant.limits.requestsPerMinute) {
    return {
      allowed: false,
      reason: `Rate limit exceeded: ${counters.minute}/${tenant.limits.requestsPerMinute} requests/minute`,
    };
  }

  // Check per-day limit
  if (counters.day >= tenant.limits.requestsPerDay) {
    return {
      allowed: false,
      reason: `Daily limit exceeded: ${counters.day}/${tenant.limits.requestsPerDay} requests/day`,
    };
  }

  // Check concurrent streams
  if (tenant.usage.activeStreams >= tenant.limits.maxConcurrentStreams) {
    return {
      allowed: false,
      reason: `Too many concurrent streams: ${tenant.usage.activeStreams}/${tenant.limits.maxConcurrentStreams}`,
    };
  }

  return { allowed: true };
}

/**
 * Check if model is allowed for tenant
 */
export function isModelAllowed(tenant: Tenant, model: string): boolean {
  if (tenant.limits.allowedModels.length === 0) {
    return true; // All models allowed
  }
  return tenant.limits.allowedModels.some(m => model.includes(m));
}

/**
 * Check if account is allowed for tenant
 */
export function isAccountAllowed(tenant: Tenant, accountId: string): boolean {
  if (tenant.limits.allowedAccounts.length === 0) {
    return true; // All accounts allowed
  }
  return tenant.limits.allowedAccounts.includes(accountId);
}

/**
 * Record request for tenant
 */
export function recordRequest(request: TenantRequest): void {
  const tenant = tenantCache.get(request.tenantId);
  if (!tenant) return;

  // Update counters
  const counters = getOrInitCounters(tenant.id);
  counters.minute++;
  counters.day++;

  // Update usage
  tenant.usage.requestsToday++;
  tenant.usage.requestsThisMinute++;
  tenant.usage.tokensToday += request.tokens;
  tenant.usage.lastRequestAt = request.timestamp;

  // Persist to DB
  try {
    getDb().prepare(`
      INSERT INTO tenant_requests 
      (tenant_id, request_id, model, tokens, latency_ms, timestamp, success)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.tenantId,
      request.requestId,
      request.model,
      request.tokens,
      request.latencyMs,
      request.timestamp,
      request.success ? 1 : 0
    );

    getDb().prepare(`
      UPDATE tenants 
      SET usage_json = ?
      WHERE id = ?
    `).run(JSON.stringify(tenant.usage), tenant.id);
  } catch (err: any) {
    console.error('[MultiTenant] Failed to record request:', err.message);
  }
}

/**
 * Increment active streams for tenant
 */
export function incrementStreams(tenantId: string): void {
  for (const tenant of tenantCache.values()) {
    if (tenant.id === tenantId) {
      tenant.usage.activeStreams++;
      break;
    }
  }
}

/**
 * Decrement active streams for tenant
 */
export function decrementStreams(tenantId: string): void {
  for (const tenant of tenantCache.values()) {
    if (tenant.id === tenantId) {
      tenant.usage.activeStreams = Math.max(0, tenant.usage.activeStreams - 1);
      break;
    }
  }
}

/**
 * Get or initialize request counters
 */
function getOrInitCounters(tenantId: string): { minute: number; day: number; lastReset: number } {
  if (!requestCounters.has(tenantId)) {
    requestCounters.set(tenantId, { minute: 0, day: 0, lastReset: Date.now() });
  }
  return requestCounters.get(tenantId)!;
}

/**
 * Get tenant usage statistics
 */
export function getTenantStats(tenantId: string, hours: number = 24): {
  totalRequests: number;
  totalTokens: number;
  avgLatency: number;
  successRate: number;
  byModel: Record<string, number>;
} {
  try {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    
    const stats = getDb().prepare(`
      SELECT 
        COUNT(*) as total_requests,
        SUM(tokens) as total_tokens,
        AVG(latency_ms) as avg_latency,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as success_rate
      FROM tenant_requests
      WHERE tenant_id = ? AND timestamp > ?
    `).get(tenantId, cutoff) as any;

    const byModel = getDb().prepare(`
      SELECT model, COUNT(*) as count
      FROM tenant_requests
      WHERE tenant_id = ? AND timestamp > ?
      GROUP BY model
    `).all(tenantId, cutoff) as any[];

    return {
      totalRequests: stats.total_requests || 0,
      totalTokens: stats.total_tokens || 0,
      avgLatency: stats.avg_latency || 0,
      successRate: stats.success_rate || 0,
      byModel: Object.fromEntries(byModel.map(r => [r.model, r.count])),
    };
  } catch (err) {
    return { totalRequests: 0, totalTokens: 0, avgLatency: 0, successRate: 0, byModel: {} };
  }
}

/**
 * Update tenant limits
 */
export function updateTenantLimits(tenantId: string, limits: Partial<TenantLimits>): boolean {
  for (const tenant of tenantCache.values()) {
    if (tenant.id === tenantId) {
      tenant.limits = { ...tenant.limits, ...limits };
      
      try {
        getDb().prepare(`
          UPDATE tenants 
          SET limits_json = ?
          WHERE id = ?
        `).run(JSON.stringify(tenant.limits), tenant.id);
        
        console.log(`[MultiTenant] Updated limits for ${tenant.name}`);
        return true;
      } catch (err: any) {
        console.error('[MultiTenant] Failed to update limits:', err.message);
        return false;
      }
    }
  }
  return false;
}

/**
 * Suspend tenant
 */
export function suspendTenant(tenantId: string): boolean {
  for (const tenant of tenantCache.values()) {
    if (tenant.id === tenantId) {
      tenant.status = 'suspended';
      
      try {
        getDb().prepare('UPDATE tenants SET status = ? WHERE id = ?').run('suspended', tenant.id);
        console.log(`[MultiTenant] Suspended tenant: ${tenant.name}`);
        return true;
      } catch (err: any) {
        console.error('[MultiTenant] Failed to suspend tenant:', err.message);
        return false;
      }
    }
  }
  return false;
}

/**
 * List all tenants
 */
export function listTenants(status?: 'active' | 'suspended'): Tenant[] {
  const tenants = Array.from(tenantCache.values());
  return status ? tenants.filter(t => t.status === status) : tenants;
}

/**
 * Delete tenant (soft delete)
 */
export function deleteTenant(tenantId: string): boolean {
  for (const [apiKey, tenant] of tenantCache.entries()) {
    if (tenant.id === tenantId) {
      tenant.status = 'deleted';
      tenantCache.delete(apiKey);
      
      try {
        getDb().prepare('UPDATE tenants SET status = ? WHERE id = ?').run('deleted', tenant.id);
        console.log(`[MultiTenant] Deleted tenant: ${tenant.name}`);
        return true;
      } catch (err: any) {
        console.error('[MultiTenant] Failed to delete tenant:', err.message);
        return false;
      }
    }
  }
  return false;
}

/**
 * Close DB connection
 */
export function closeTenantDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  tenantCache.clear();
  requestCounters.clear();
}
