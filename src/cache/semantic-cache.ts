/**
 * File: semantic-cache.ts
 * Project: qwenproxy
 * Semantic cache entry point - uses HNSW for O(log n) similarity search
 */

export { SemanticCacheHNSW as SemanticCache, semanticCacheHNSW as semanticCache } from './semantic-cache-hnsw.js';
export type { CacheEntry } from './semantic-cache-hnsw.js';