/*
 * Tests: opentelemetry.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { startTrace, endTrace, addTag, withTrace, setOpenTelemetryConfig } from '../core/opentelemetry.js';

describe('OpenTelemetry', () => {
  it('deve criar trace context', () => {
    setOpenTelemetryConfig({ enabled: true, samplingRate: 1.0 });
    const ctx = startTrace('test-operation');
    assert.ok(ctx.traceId);
    assert.ok(ctx.spanId);
    assert.strictEqual(ctx.traceId.length, 32);
    assert.strictEqual(ctx.spanId.length, 16);
  });

  it('deve encerrar trace sem erro', () => {
    const ctx = startTrace('test-end');
    endTrace(ctx);
    // Não deve lançar
    assert.ok(true);
  });

  it('deve adicionar tags ao span', () => {
    const ctx = startTrace('test-tags');
    addTag('model', 'qwen3.7-plus', ctx);
    addTag('tokens', 100, ctx);
    endTrace(ctx);
    assert.ok(true);
  });

  it('deve executar withTrace corretamente', async () => {
    const result = await withTrace('async-op', async (ctx) => {
      assert.ok(ctx.traceId);
      return 42;
    });
    assert.strictEqual(result, 42);
  });

  it('deve capturar erro no withTrace', async () => {
    await assert.rejects(async () => {
      await withTrace('error-op', async () => {
        throw new Error('test error');
      });
    });
  });
});
