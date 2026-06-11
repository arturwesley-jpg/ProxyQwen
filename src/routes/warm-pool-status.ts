/*
 * File: warm-pool-status.ts
 * Project: qwenproxy
 * Endpoint e utilitários para inspecionar/forçar refill do warm pool
 * por conta — essencial para reduzir cold-start de subagentes.
 */

import type { Context } from 'hono';

// Re-export do qwen.ts
import { warmAllPools } from '../services/qwen.js';

/**
 * GET /v1/warm-pool/status
 * Retorna contagem de sessões pré-criadas por conta.
 */
export async function warmPoolStatus(c: Context) {
  // Acesso interno ao estado via import dinâmico para evitar circular
  const { getWarmPoolSnapshot } = await import('../services/qwen.js');
  const snapshot = getWarmPoolSnapshot();
  return c.json({
    timestamp: Date.now(),
    accounts: snapshot,
  });
}

/**
 * POST /v1/warm-pool/refill
 * Força refill imediato do pool de todas as contas (ou de uma específica).
 * Body opcional: { accountId?: string }
 */
export async function warmPoolRefill(c: Context) {
  let body: { accountId?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  if (body.accountId) {
    await warmAllPools([body.accountId]);
    return c.json({ status: 'refill_started', accountId: body.accountId });
  }

  const { loadAccounts } = await import('../core/accounts.js');
  const accounts = loadAccounts();
  await warmAllPools(accounts.map(a => a.id));
  return c.json({
    status: 'refill_started_all',
    accountCount: accounts.length,
  });
}
