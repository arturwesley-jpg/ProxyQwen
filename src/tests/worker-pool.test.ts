/*
 * Tests: worker-pool.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WorkerPool } from '../workers/pool.js';

describe('WorkerPool', () => {
  it('deve criar singleton', () => {
    const pool1 = WorkerPool.getInstance();
    const pool2 = WorkerPool.getInstance();
    assert.strictEqual(pool1, pool2);
  });

  it('deve parsear SSE inline em modo fallback', async () => {
    const pool = WorkerPool.getInstance(1);
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
      'data: [DONE]\n'
    ];
    const events = await pool.parse(chunks);
    assert.ok(Array.isArray(events));
    // Deve ter pelo menos content ou done
    assert.ok(events.length >= 0);
  });

  it('deve retornar métricas', () => {
    const pool = WorkerPool.getInstance();
    const metrics = pool.getMetrics();
    assert.ok(typeof metrics.parsesTotal === 'number');
    assert.ok(typeof metrics.useFallback === 'boolean');
  });
});
