/*
 * Tests: token-estimation.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { countTokens, estimateTokensFast, compareWithHeuristic, clearTokenCache } from '../utils/token-estimation.js';

describe('TokenEstimation', () => {
  it('deve contar tokens de texto ASCII simples', () => {
    const text = 'Hello world, this is a test.';
    const count = countTokens(text);
    assert.ok(count > 0 && count < 20, `Contagem deve ser razoável: ${count}`);
  });

  it('deve detectar e contar CJK corretamente', () => {
    const text = '你好世界'; // 4 caracteres CJK ~ 6 tokens
    const count = countTokens(text);
    assert.ok(count >= 4, `CJK deve ter ~1.5 token/char: ${count}`);
  });

  it('deve identificar texto como código', () => {
    const code = 'function hello() { return "world"; }';
    const tokens = countTokens(code);
    assert.ok(tokens > 0);
  });

  it('deve usar cache em chamadas repetidas', () => {
    clearTokenCache();
    const text = 'Texto para testar cache';
    const t1 = countTokens(text, 'qwen3.7-plus');
    const t2 = countTokens(text, 'qwen3.7-plus');
    assert.strictEqual(t1, t2, 'Cache deve retornar mesmo valor');
  });

  it('deve comparar com heurística antiga', () => {
    const text = 'Uma pergunta simples sobre o clima hoje em São Paulo.';
    const comp = compareWithHeuristic(text, 'qwen3.7-plus');
    assert.ok(comp.newMethod > 0);
    assert.ok(comp.oldMethod > 0);
    assert.ok(comp.percentDiff < 100, `Diferença deve ser < 100%: ${comp.percentDiff}%`);
  });

  it('deve ter fast path para textos grandes', () => {
    const big = 'word '.repeat(50000); // ~250KB
    const fast = estimateTokensFast(big);
    assert.ok(fast > 0);
  });
});
