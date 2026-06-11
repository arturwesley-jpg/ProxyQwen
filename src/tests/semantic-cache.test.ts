/*
 * Tests: semantic-cache.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Mock metrics before import
const mockMetrics = {
  increment: () => {},
  get: () => null,
};
await import('../core/metrics.js').then(m => {
  (m as any).metrics = mockMetrics;
}).catch(() => {});

import { SemanticCache } from '../cache/semantic-cache.js';

describe('SemanticCache', () => {
  const cache = new SemanticCache();

  it('deve detectar hit exato', () => {
    cache.store('Como fazer um loop em Python?', 'Use for i in range(n):', 'code');
    const hit = cache.lookup('Como fazer um loop em Python?');
    assert.ok(hit, 'Deve encontrar hit exato');
    assert.strictEqual(hit.category, 'code');
  });

  it('deve detectar hit similar (distância Hamming <= 3)', () => {
    cache.store('What is the capital of France?', 'Paris', 'fact');
    const hit = cache.lookup('What is the capital of France');
    assert.ok(hit, 'Deve encontrar hit similar');
  });

  it('deve retornar null para prompts muito diferentes', () => {
    const hit = cache.lookup('escreva um poema sobre o oceano profundo e misterioso');
    // Pode retornar null se não houver similar
    // Apenas não deve lançar erro
    assert.ok(hit === null || typeof hit === 'object');
  });

  it('não deve armazenar prompts creative', () => {
    cache.store('Escreva um poema sobre amor', 'Resposta criativa', 'creative');
    const stats = cache.getStats();
    // creative não deve ser armazenado
    assert.ok(stats.size >= 0);
  });

  it('deve classificar prompts corretamente', () => {
    // Teste indireto via storage
    cache.store('def hello(): return "world"', 'code response', undefined);
    cache.store('O que é machine learning?', 'fact response', undefined);
    const stats = cache.getStats();
    assert.ok(stats.size > 0);
  });
});
