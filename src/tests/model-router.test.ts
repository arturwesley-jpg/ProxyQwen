/*
 * Tests: model-router.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractFeatures, routeModel, setRouterConfig } from '../core/model-router.js';

describe('ModelRouter', () => {
  it('deve extrair features de prompt simples', () => {
    const features = extractFeatures('O que é TypeScript?', 0, false);
    assert.ok(features.length > 0);
    assert.strictEqual(features.hasImage, false);
    assert.strictEqual(features.hasCode, false);
    assert.strictEqual(features.isFactual, true);
  });

  it('deve detectar código', () => {
    const features = extractFeatures('function hello() { console.log("hi"); }', 0, false);
    assert.strictEqual(features.hasCode, true);
  });

  it('deve detectar multimodal', () => {
    const features = extractFeatures('Descreva esta imagem', 0, true);
    assert.strictEqual(features.hasImage, true);
  });

  it('deve detectar idioma PT', () => {
    const features = extractFeatures('O que você acha disso?', 0, false);
    assert.strictEqual(features.language, 'pt');
  });

  it('deve rotear código para qwen3-coder-plus', () => {
    const features = extractFeatures('Escreva uma function em Python', 0, false);
    const decision = routeModel(features);
    assert.strictEqual(decision.chosenModel, 'qwen3-coder-plus');
  });

  it('deve rotear multimodal para qwen3-vl-plus', () => {
    const features = extractFeatures('Descreva a imagem', 0, true);
    const decision = routeModel(features);
    assert.strictEqual(decision.chosenModel, 'qwen3-vl-plus');
  });

  it('deve respeitar escolha do cliente', () => {
    setRouterConfig({ respectClientChoice: true });
    const features = extractFeatures('teste', 0, false);
    const decision = routeModel(features, 'qwen3.6-27b');
    assert.strictEqual(decision.chosenModel, 'qwen3.6-27b');
    assert.strictEqual(decision.reason, 'client_choice');
  });

  it('deve usar modelo rápido para factual simples', () => {
    const features = extractFeatures('O que é Python?', 0, false);
    const decision = routeModel(features);
    assert.strictEqual(decision.chosenModel, 'qwen3.6-27b');
  });
});
