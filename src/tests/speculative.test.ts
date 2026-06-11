/*
 * Tests: speculative.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { textSimilarity, toNoThinkingModel, supportsSpeculative } from '../services/speculative.js';

describe('Speculative', () => {
  it('deve calcular similaridade de textos idênticos', () => {
    const sim = textSimilarity('hello world', 'hello world');
    assert.strictEqual(sim, 1);
  });

  it('deve calcular similaridade de textos similares', () => {
    const sim = textSimilarity(
      'A resposta é 42 e isso é tudo',
      'A resposta é 42 e essa é a conclusão'
    );
    assert.ok(sim > 0.5, `Similaridade deve ser > 0.5: ${sim}`);
  });

  it('deve calcular similaridade baixa para textos diferentes', () => {
    const sim = textSimilarity(
      'Python é uma linguagem de programação',
      'Banana é uma fruta amarela tropical'
    );
    assert.ok(sim < 0.3, `Similaridade deve ser < 0.3: ${sim}`);
  });

  it('deve converter modelo para no-thinking', () => {
    assert.strictEqual(toNoThinkingModel('qwen3.7-plus'), 'qwen3.7-plus-no-thinking');
    assert.strictEqual(toNoThinkingModel('qwen3.7-plus-no-thinking'), 'qwen3.7-plus-no-thinking');
  });

  it('deve detectar modelos suportados', () => {
    assert.strictEqual(supportsSpeculative('qwen3.7-plus'), true);
    assert.strictEqual(supportsSpeculative('qwen3.7-plus-no-thinking'), false);
    assert.strictEqual(supportsSpeculative('qwen3.6-27b'), false);
  });
});
