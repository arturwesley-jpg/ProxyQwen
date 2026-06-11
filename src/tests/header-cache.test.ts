/*
 * Tests: header-cache.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { HeaderCacheSQLite } from '../services/header-cache.js';

describe('HeaderCache', () => {
  it('deve armazenar e recuperar headers', () => {
    const cache = new HeaderCacheSQLite(60000);
    cache.set('account-1', { cookie: 'test', 'user-agent': 'ua' }, 'session-1');
    const result = cache.get('account-1');
    assert.ok(result);
    assert.strictEqual(result.headers.cookie, 'test');
  });

  it('deve detectar headers stale', () => {
    const cache = new HeaderCacheSQLite(100); // 100ms TTL
    cache.set('account-2', { cookie: 'test' });
    assert.strictEqual(cache.isStale('account-2'), false);
  });

  it('deve adquirir mutex de refresh', async () => {
    const cache = new HeaderCacheSQLite();
    const promise = Promise.resolve();
    const acquired = cache.acquireRefreshMutex('account-3', promise);
    assert.strictEqual(acquired, true);
    assert.strictEqual(cache.isRefreshInProgress('account-3'), true);
    await promise;
  });

  it('deve retornar stats', () => {
    const cache = new HeaderCacheSQLite();
    const stats = cache.getStats();
    assert.ok(typeof stats.size === 'number');
  });
});
