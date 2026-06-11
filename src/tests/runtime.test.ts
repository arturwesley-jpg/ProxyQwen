/*
 * Tests: runtime.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectRuntime } from '../core/runtime.js';

describe('Runtime', () => {
  it('deve detectar runtime', () => {
    const runtime = detectRuntime();
    assert.ok(['node', 'bun'].includes(runtime.name));
    assert.ok(runtime.version);
    assert.strictEqual(runtime.isNode || runtime.isBun, true);
  });

  it('deve cacheiar resultado', () => {
    const r1 = detectRuntime();
    const r2 = detectRuntime();
    assert.strictEqual(r1.name, r2.name);
  });
});
