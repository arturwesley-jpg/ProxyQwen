/*
 * Tests: account-lock.ts
 * Validates S2 concurrency lock behavior for multi-agent scenarios
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  acquireAccountLock,
  isAccountLocked,
  getLockInfo,
  getLockMetrics,
  getAllLocks,
  forceRelease,
  cleanupStuckLocks,
} from '../core/account-lock.js';

describe('AccountLock - S2 Multi-Agent Concurrency', () => {
  // Unique account IDs per test to avoid cross-test pollution
  const mkId = (suffix: string) => `test-acc-${Date.now()}-${suffix}`;

  it('deve adquirir lock em conta livre imediatamente', async () => {
    const accId = mkId('free');
    const lock = await acquireAccountLock(accId, 'agent-1', 0);
    assert.ok(lock, 'Lock deve ser adquirido');
    assert.strictEqual(isAccountLocked(accId), true);

    const info = getLockInfo(accId);
    assert.strictEqual(info.locked, true);
    assert.strictEqual(info.owner, 'agent-1');
    assert.ok(info.heldForMs !== undefined);

    lock!.release();
    assert.strictEqual(isAccountLocked(accId), false);
  });

  it('deve falhar rápido (timeout=0) quando conta está ocupada', async () => {
    const accId = mkId('busy-fast');
    const lock1 = await acquireAccountLock(accId, 'agent-1', 0);
    assert.ok(lock1);

    const start = Date.now();
    const lock2 = await acquireAccountLock(accId, 'agent-2', 0);
    const elapsed = Date.now() - start;

    assert.strictEqual(lock2, null, 'Segundo lock deve falhar com timeout=0');
    assert.ok(elapsed < 50, 'Deve falhar imediatamente');

    lock1!.release();
  });

  it('deve aguardar e adquirir quando timeout > 0 e lock é liberado', async () => {
    const accId = mkId('wait-release');
    const lock1 = await acquireAccountLock(accId, 'agent-1', 0);
    assert.ok(lock1);

    // Release after 100ms
    setTimeout(() => lock1!.release(), 100);

    const start = Date.now();
    const lock2 = await acquireAccountLock(accId, 'agent-2', 5000);
    const elapsed = Date.now() - start;

    assert.ok(lock2, 'Segundo agente deve conseguir após liberação');
    assert.ok(elapsed >= 80 && elapsed < 1000, `Esperou ~100ms (foi ${elapsed}ms)`);

    lock2!.release();
  });

  it('deve dar timeout quando conta fica ocupada além do limite', async () => {
    const accId = mkId('timeout');
    const lock1 = await acquireAccountLock(accId, 'agent-1', 0);
    assert.ok(lock1);

    const start = Date.now();
    const lock2 = await acquireAccountLock(accId, 'agent-2', 150);
    const elapsed = Date.now() - start;

    assert.strictEqual(lock2, null, 'Deve retornar null após timeout');
    assert.ok(elapsed >= 140 && elapsed < 500, `Respeitou ~150ms timeout (foi ${elapsed}ms)`);

    lock1!.release();
  });

  it('deve suportar múltiplas contas em paralelo (cenário multi-agente)', async () => {
    const accounts = [mkId('par-a'), mkId('par-b'), mkId('par-c')];

    // 3 agentes adquirem locks em contas diferentes simultaneamente
    const locks = await Promise.all(
      accounts.map((accId, i) =>
        acquireAccountLock(accId, `agent-${i}`, 0)
      )
    );

    assert.ok(locks.every(l => l !== null), 'Todos devem adquirir lock em contas diferentes');
    assert.ok(accounts.every(id => isAccountLocked(id)), 'Todas contas devem estar locked');

    // Liberar todos
    locks.forEach(l => l!.release());
    assert.ok(accounts.every(id => !isAccountLocked(id)), 'Todas contas devem estar livres');
  });

  it('deve expor métricas de contenção', async () => {
    const accId = mkId('metrics');

    const before = getLockMetrics();
    const lock1 = await acquireAccountLock(accId, 'a', 0);
    const lock2 = await acquireAccountLock(accId, 'b', 0); // contended, fails
    const after = getLockMetrics();

    assert.ok(after.totalAcquires >= before.totalAcquires + 2);
    assert.ok(after.totalContended >= before.totalContended + 1);

    lock1!.release();
  });

  it('deve listar todos os locks ativos', async () => {
    const accId = mkId('list');
    const lock = await acquireAccountLock(accId, 'list-owner', 0);

    const all = getAllLocks();
    assert.ok(accId in all, 'Lock deve aparecer em getAllLocks');
    assert.strictEqual(all[accId].owner, 'list-owner');

    lock!.release();
  });

  it('deve limpar locks stuck após maxAge', async () => {
    const accId = mkId('stuck');
    const lock = await acquireAccountLock(accId, 'stuck-owner', 0);

    // Não chamamos release — simula um lock esquecido
    assert.strictEqual(isAccountLocked(accId), true);

    // Cleanup com maxAge=0 limpa tudo imediatamente
    const cleaned = cleanupStuckLocks(0);
    assert.ok(cleaned >= 1, 'Deve ter limpado pelo menos 1 lock');
    assert.strictEqual(isAccountLocked(accId), false, 'Lock stuck deve ter sido liberado');

    // Cleanup sem efeito se já liberado
    try { lock!.release(); } catch {} // pode lançar ou não, ok
  });

  it('forceRelease deve liberar conta presa', async () => {
    const accId = mkId('force');
    await acquireAccountLock(accId, 'victim', 0);
    assert.strictEqual(isAccountLocked(accId), true);

    const released = forceRelease(accId);
    assert.strictEqual(released, true);
    assert.strictEqual(isAccountLocked(accId), false);
  });

  it('fila FIFO: waiters devem ser atendidos em ordem', async () => {
    const accId = mkId('fifo');
    const lock0 = await acquireAccountLock(accId, 'holder', 0);
    assert.ok(lock0);

    const order: string[] = [];

    // 3 waiters entram na fila
    const p1 = acquireAccountLock(accId, 'first', 2000).then(l => { order.push('first'); return l; });
    const p2 = acquireAccountLock(accId, 'second', 2000).then(l => { order.push('second'); return l; });
    const p3 = acquireAccountLock(accId, 'third', 2000).then(l => { order.push('third'); return l; });

    // Libera o holder — primeiro da fila deve assumir
    await new Promise(r => setTimeout(r, 30));
    lock0!.release();

    const lock1 = await p1;
    assert.ok(lock1);
    assert.deepStrictEqual(order, ['first']);

    lock1!.release();
    const lock2 = await p2;
    assert.deepStrictEqual(order, ['first', 'second']);

    lock2!.release();
    const lock3 = await p3;
    assert.deepStrictEqual(order, ['first', 'second', 'third']);

    lock3!.release();
  });
});
