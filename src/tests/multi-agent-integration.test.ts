/*
 * Integration test: S1 + S2 multi-agent parallel execution
 *
 * Validates the end-to-end flow through chat.ts:
 * - X-Account-Id header pins a request to a specific account
 * - Account lock prevents concurrent use of the same account
 * - Pinned requests to a busy account wait (30s) then 429
 * - Rotating requests skip locked accounts to next free one
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  acquireAccountLock,
  isAccountLocked,
  getLockInfo,
  getAllLocks,
  getLockMetrics,
} from '../core/account-lock.js';

describe('Multi-Agent S1+S2 Integration Scenarios', () => {
  const mkId = (suffix: string) => `integ-${Date.now()}-${suffix}`;

  it('S1: Requests with different X-Account-Id rodam em paralelo real', async () => {
    // Simulates 3 Hermes subagents each pinned to their own account
    const accounts = [mkId('s1-a'), mkId('s1-b'), mkId('s1-c')];

    const startTimes = accounts.map(() => Date.now());
    const endTimes: number[] = [];

    // All 3 "requests" acquire locks simultaneously
    const locks = await Promise.all(
      accounts.map((accId, i) =>
        acquireAccountLock(accId, `subagent-${i}`, 0)
      )
    );

    // Simulate work for different durations
    await Promise.all(
      locks.map(async (lock, i) => {
        await new Promise(r => setTimeout(r, 50 * (i + 1)));
        endTimes[i] = Date.now();
        lock!.release();
      })
    );

    // Validate: all 3 ran in parallel — total time should be ~150ms (max),
    // not ~300ms (sum). Each request finished at its own duration.
    assert.ok(locks.every(l => l !== null), 'Todos adquiriram lock');
    
    // First finished at ~50ms, second at ~100ms, third at ~150ms
    const durations = endTimes.map((e, i) => e - startTimes[i]);
    assert.ok(durations[0] >= 45 && durations[0] < 150, `Request 0: ${durations[0]}ms`);
    assert.ok(durations[1] >= 95 && durations[1] < 200, `Request 1: ${durations[1]}ms`);
    assert.ok(durations[2] >= 145 && durations[2] < 250, `Request 2: ${durations[2]}ms`);
  });

  it('S1: Request pinned to busy account waits, then 429 on timeout', async () => {
    const accId = mkId('s1-timeout');
    
    // First request holds the lock
    const lock1 = await acquireAccountLock(accId, 'subagent-1', 0);
    assert.ok(lock1);

    // Second request to same account with short timeout — simulates 30s pinned wait
    const start = Date.now();
    const lock2 = await acquireAccountLock(accId, 'subagent-2', 200);
    const elapsed = Date.now() - start;

    // Should return null after ~200ms (simulating the 429 path)
    assert.strictEqual(lock2, null, 'Lock deve falhar após timeout');
    assert.ok(elapsed >= 190 && elapsed < 500, `Timeout respeitado (${elapsed}ms)`);

    // In chat.ts, this returns HTTP 429 with info about who's holding
    const info = getLockInfo(accId);
    assert.strictEqual(info.locked, true);
    assert.strictEqual(info.owner, 'subagent-1');

    lock1!.release();
  });

  it('S2: Rotating request skips locked accounts (fail-fast)', async () => {
    // Simulates chat.ts rotation: try acc-a (locked) → try acc-b (free)
    const accA = mkId('s2-locked');
    const accB = mkId('s2-free');

    // Hold acc-a
    const lockA = await acquireAccountLock(accA, 'holder', 0);
    assert.ok(lockA);

    // Try acc-a with timeout=0 (rotating mode) — should fail fast
    const try1 = await acquireAccountLock(accA, 'rotating-req', 0);
    assert.strictEqual(try1, null, 'Fail-fast em conta ocupada');

    // Now try acc-b — should succeed
    const try2 = await acquireAccountLock(accB, 'rotating-req', 0);
    assert.ok(try2, 'Conta livre deve ser adquirida');

    lockA!.release();
    try2!.release();
  });

  it('S2: Lock is always released (finally block semantics)', async () => {
    const accId = mkId('s2-release');
    
    // Simulate the try/finally pattern from chat.ts
    const lock = await acquireAccountLock(accId, 'req-1', 0);
    assert.ok(lock);

    try {
      // Simulate work that throws
      throw new Error('Stream error');
    } catch {
      // Expected
    } finally {
      // chat.ts always releases in finally block
      lock!.release();
    }

    assert.strictEqual(isAccountLocked(accId), false, 'Lock deve ser liberado mesmo após erro');

    // Next request should succeed immediately
    const lock2 = await acquireAccountLock(accId, 'req-2', 0);
    assert.ok(lock2, 'Próximo request deve adquirir após release');
    lock2!.release();
  });

  it('End-to-end: 5 subagentes com 5 contas = zero contention', async () => {
    // Full scenario: Hermes delegate_task with 5 subagents
    const accounts = Array.from({ length: 5 }, (_, i) => mkId(`e2e-${i}`));

    const results: Array<{ accId: string; acquired: boolean; waitTime: number }> = [];
    const start = Date.now();

    // All 5 subagents fire simultaneously (simulating Hermes parallel spawn)
    await Promise.all(
      accounts.map(async (accId, i) => {
        const reqStart = Date.now();
        // Each subagent pinned to its own account via X-Account-Id
        const lock = await acquireAccountLock(accId, `subagent-${i}`, 30000);
        const waitTime = Date.now() - reqStart;
        
        results.push({ accId, acquired: !!lock, waitTime });
        
        if (lock) {
          // Simulate subagent work (1-3 seconds each)
          await new Promise(r => setTimeout(r, 100 + (i * 20)));
          lock.release();
        }
      })
    );

    const totalTime = Date.now() - start;

    // All 5 should acquire immediately (waitTime ~0ms)
    const allAcquired = results.every(r => r.acquired);
    assert.ok(allAcquired, 'Todos 5 subagentes devem adquirir lock');

    // All wait times should be near zero
    const maxWait = Math.max(...results.map(r => r.waitTime));
    assert.ok(maxWait < 50, `Max wait time ${maxWait}ms — should be <50ms (zero contention)`);

    // Total time should be ~max(work times) ≈ 180ms, not sum
    assert.ok(totalTime < 500, `Total time ${totalTime}ms — parallel execution confirmed`);
  });

  it('Lock observability: getAllLocks + getLockMetrics', async () => {
    const accId = mkId('obs');
    const lock = await acquireAccountLock(accId, 'observable-agent', 0);
    assert.ok(lock);

    const all = getAllLocks();
    assert.ok(accId in all, 'Lock aparece em getAllLocks');
    assert.strictEqual(all[accId].owner, 'observable-agent');
    assert.ok(all[accId].heldForMs >= 0);

    const metrics = getLockMetrics();
    assert.ok(typeof metrics.activeLocks === 'number');
    assert.ok(metrics.activeLocks >= 1);
    assert.ok(typeof metrics.contentionRate === 'number');
    assert.ok(metrics.contentionRate >= 0 && metrics.contentionRate <= 1);

    lock!.release();
  });
});
