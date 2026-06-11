/*
 * Benchmark: before/after comparison of new modules
 */

import { countTokens, estimateTokensFast, compareWithHeuristic } from '../utils/token-estimation.js';
import { SemanticCache } from '../cache/semantic-cache.js';
import { HeaderCacheSQLite } from '../services/header-cache.js';
import { extractFeatures, routeModel } from '../core/model-router.js';

// Test prompts
const PROMPTS = [
  'O que é TypeScript?',
  'Write a function to sort an array',
  'Explique como funciona o async/await em JavaScript',
  'What is the capital of France?',
  'def hello(): return "world"',
  'Escreva um poema sobre o oceano',
  'Como fazer uma requisição HTTP em Python?',
  'What are the benefits of functional programming?',
];

function bench(name: string, fn: () => void, iterations = 10000): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round((iterations / elapsed) * 1000);
  console.log(`  ${name}: ${elapsed.toFixed(2)}ms total, ${opsPerSec.toLocaleString()} ops/s`);
  return opsPerSec;
}

console.log('\n=== BENCHMARK: QwenProxy New Modules ===\n');

// 1. Token estimation
console.log('1. Token Estimation');
const sampleText = 'Hello world, this is a sample text for benchmarking token estimation algorithms.';
bench('countTokens (cached)', () => countTokens(sampleText, 'qwen3.7-plus'));
bench('estimateTokensFast', () => estimateTokensFast(sampleText, 'qwen3.7-plus'));
bench('compareWithHeuristic', () => compareWithHeuristic(sampleText, 'qwen3.7-plus'));

// 2. Semantic Cache
console.log('\n2. Semantic Cache');
const cache = new SemanticCache();
for (const p of PROMPTS) cache.store(p, 'cached response', undefined);
bench('lookup (hit)', () => cache.lookup('O que é TypeScript'));
bench('lookup (miss)', () => cache.lookup('pergunta totalmente diferente sobre outro assunto'));

// 3. Header Cache
console.log('\n3. Header Cache');
const hcache = new HeaderCacheSQLite();
for (let i = 0; i < 10; i++) {
  hcache.set(`acc-${i}`, { cookie: 'test', ua: 'ua' });
}
bench('header get (memory)', () => hcache.get('acc-0'));
bench('header isStale', () => hcache.isStale('acc-0'));

// 4. Model Router
console.log('\n4. Model Router');
bench('extractFeatures', () => extractFeatures('How to write a Python function?', 0, false));
const feats = extractFeatures('How to write a Python function?', 0, false);
bench('routeModel', () => routeModel(feats));

// 5. Memory usage
console.log('\n5. Memory Usage');
const mem = process.memoryUsage();
console.log(`  Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
console.log(`  Heap total: ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`);
console.log(`  RSS: ${(mem.rss / 1024 / 1024).toFixed(2)} MB`);

console.log('\n=== BENCHMARK COMPLETE ===\n');
