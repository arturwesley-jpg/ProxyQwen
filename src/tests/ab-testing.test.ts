/*
 * Tests: ab-testing.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createExperiment, getExperimentForUser, welchTTest, listExperiments } from '../core/ab-testing.js';

describe('ABTesting', () => {
  it('deve criar experimento', () => {
    const exp = createExperiment(
      'test-experiment-' + Date.now(),
      'Teste unitário',
      [
        { name: 'control', weight: 0.5, config: { model: 'qwen3.6-27b' } },
        { name: 'variant', weight: 0.5, config: { model: 'qwen3.7-plus' } },
      ],
      1.0 // 100% traffic para teste
    );
    assert.ok(exp.id);
    assert.strictEqual(exp.variants.length, 2);
    assert.strictEqual(exp.status, 'active');
  });

  it('deve atribuir variante deterministicamente', () => {
    const exp = createExperiment(
      'deterministic-' + Date.now(),
      'Teste de determinismo',
      [
        { name: 'A', weight: 0.5, config: {} },
        { name: 'B', weight: 0.5, config: {} },
      ],
      1.0
    );

    const result1 = getExperimentForUser('user-123');
    const result2 = getExperimentForUser('user-123');

    // Mesma user deve receber mesma variante
    if (result1 && result2 && result1.experiment.id === result2.experiment.id) {
      assert.strictEqual(result1.variant.name, result2.variant.name);
    }
  });

  it('deve calcular Welch t-test', () => {
    const group1 = { mean: 100, variance: 25, n: 50 };
    const group2 = { mean: 110, variance: 30, n: 50 };
    const result = welchTTest(group1, group2);
    assert.ok(typeof result.tStatistic === 'number');
    assert.ok(result.pValue >= 0 && result.pValue <= 1);
    assert.ok(typeof result.significant === 'boolean');
  });

  it('deve listar experimentos', () => {
    const all = listExperiments();
    assert.ok(Array.isArray(all));
  });
});
