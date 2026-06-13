/**
 * File: chat/auth.ts
 * Project: qwenproxy
 * Multi-tenant authentication + rate limiting
 */

import { Context } from 'hono';
import { authenticateTenant, canMakeRequest, isModelAllowed, incrementStreams, decrementStreams } from '../../core/multi-tenant.js';
import { metrics } from '../../core/metrics.js';

export interface TenantAuthResult {
  tenant: any;
  errorResponse?: any;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

export async function authenticateRequest(c: Context): Promise<TenantAuthResult> {
  if (process.env.MULTI_TENANT_ENABLED !== 'true') {
    return { tenant: null };
  }
  
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || '';
  const tenant = authenticateTenant(apiKey);
  
  if (!tenant) {
    return { 
      tenant: null, 
      errorResponse: c.json({ error: 'Invalid or missing tenant API key' }, 401) 
    };
  }
  
  return { tenant };
}

export function checkRateLimit(tenant: any): RateLimitResult {
  if (!tenant) return { allowed: true };
  
  const canReq = canMakeRequest(tenant);
  if (!canReq.allowed) {
    return { allowed: false, reason: canReq.reason };
  }
  
  return { allowed: true };
}

export function checkModelAllowed(tenant: any, model: string): boolean {
  if (!tenant) return true;
  return isModelAllowed(tenant, model);
}

export function trackStreamStart(tenant: any): void {
  if (tenant) {
    incrementStreams(tenant.id);
  }
}

export function trackStreamEnd(
  tenant: any,
  requestId: string,
  model: string,
  tokens: number,
  latencyMs: number,
  success: boolean
): void {
  if (!tenant) return;
  
  decrementStreams(tenant.id);
  
  // Record request for usage accounting
  const { recordRequest } = require('../../core/multi-tenant.js');
  recordRequest({
    tenantId: tenant.id,
    requestId,
    model,
    tokens,
    latencyMs,
    timestamp: Date.now(),
    success,
  });
}

export function incrementRequestMetrics(): void {
  metrics.increment('requests.total');
}

export function recordRequestLatency(startTime: number): number {
  const duration = Date.now() - startTime;
  try {
    metrics.histogram('latency.request', duration);
  } catch {}
  return duration;
}