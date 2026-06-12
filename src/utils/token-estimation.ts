/*
 * File: token-estimation.ts
 * Project: qwenproxy
 * Adaptive token estimation with BPE-like algorithm
 */

import { getModelTokenDivisor } from '../core/model-registry.js';

interface TokenCacheEntry {
  count: number;
  timestamp: number;
}

const CACHE_MAX_SIZE = 5000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const LARGE_TEXT_THRESHOLD = 100 * 1024; // 100KB

const tokenCache = new Map<string, TokenCacheEntry>();

/**
 * Simple hash for cache key (FNV-1a 32-bit)
 */
function hashString(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Check if character is CJK (Chinese, Japanese, Korean)
 */
function isCJK(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
    (code >= 0x3040 && code <= 0x309F) ||   // Hiragana
    (code >= 0x30A0 && code <= 0x30FF) ||   // Katakana
    (code >= 0xAC00 && code <= 0xD7AF)      // Hangul
  );
}

/**
 * Check if character is common punctuation
 */
function isPunctuation(char: string): boolean {
  return /[.,!?;:'"()\[\]{}<>\/\\|@#$%^&*_+=~`]/.test(char);
}

/**
 * Check if text looks like code
 */
function isCodeLike(text: string): boolean {
  const codePatterns = [
    /\b(function|const|let|var|class|import|export|return|if|else|for|while)\b/,
    /[{}();]/,
    /^\s*\/\//m,
    /^\s*#/m,
    /```/,
  ];
  return codePatterns.some(p => p.test(text));
}

/**
 * Count tokens using BPE-like algorithm
 */
export function countTokens(text: string, model?: string): number {
  if (!text || text.length === 0) return 0;

  // Check cache first
  const cacheKey = hashString(text + (model || ''));
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.count;
  }

  // Fast path for very large texts
  if (text.length > LARGE_TEXT_THRESHOLD) {
    const divisor = model ? getModelTokenDivisor(model) : 2.0;
    return Math.ceil(text.length / divisor);
  }

  let tokens = 0;
  const isCode = isCodeLike(text);
  const codeMultiplier = isCode ? 1.1 : 1.0;

  // Split into segments by whitespace
  const segments = text.split(/\s+/).filter(s => s.length > 0);

  for (const segment of segments) {
    // Count CJK characters (each ~1.5 tokens)
    let cjkCount = 0;
    for (const char of segment) {
      if (isCJK(char)) {
        cjkCount++;
      }
    }

    if (cjkCount > 0) {
      tokens += cjkCount * 1.5;
      // Count remaining non-CJK chars explicitly
      let nonCjkCount = 0;
      for (const char of segment) {
        if (!isCJK(char) && char.trim().length > 0) nonCjkCount++;
      }
      if (nonCjkCount > 0) {
        tokens += nonCjkCount / 4;
      }
    } else {
      // ASCII/Latin text
      // Split by punctuation
      const parts = segment.split(/([.,!?;:'"()\[\]{}])/).filter(p => p.length > 0);

      for (const part of parts) {
        if (isPunctuation(part)) {
          tokens += 1; // Each punctuation is ~1 token
        } else if (part.length <= 4) {
          tokens += 1; // Short words are usually 1 token
        } else {
          // Longer words: ~4 chars per token
          tokens += Math.ceil(part.length / 4);
        }
      }
    }
  }

  // Apply model-specific divisor adjustment
  const divisor = model ? getModelTokenDivisor(model) : 2.0;
  
  // For CJK-heavy text, don't apply the base /2.0 normalization since we already use 1.5 tokens/char
  // For ASCII text, the base /2.0 approximates the ~4 chars/token heuristic
  let adjustedTokens: number;
  if (tokens > 0) {
    // Check if text has significant CJK content
    const hasSignificantCJK = text.split('').some(c => isCJK(c));
    if (hasSignificantCJK) {
      // CJK already uses ~1.5 tokens/char, apply divisor directly
      adjustedTokens = Math.ceil((tokens / divisor) * codeMultiplier);
    } else {
      // ASCII/Latin: base /2.0 then adjust for model
      adjustedTokens = Math.ceil((tokens / 2.0) * (2.0 / divisor) * codeMultiplier);
    }
  } else {
    adjustedTokens = 0;
  }

  // Cache result
  if (tokenCache.size >= CACHE_MAX_SIZE) {
    // Evict oldest entry
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of tokenCache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) tokenCache.delete(oldestKey);
  }

  tokenCache.set(cacheKey, {
    count: adjustedTokens,
    timestamp: Date.now(),
  });

  return adjustedTokens;
}

/**
 * Fast estimation without caching (for large texts)
 */
export function estimateTokensFast(text: string, model?: string): number {
  if (!text || text.length === 0) return 0;
  const divisor = model ? getModelTokenDivisor(model) : 2.0;
  return Math.ceil(text.length / divisor);
}

/**
 * Compare with old heuristic (for testing)
 */
export function compareWithHeuristic(text: string, model?: string): {
  newMethod: number;
  oldMethod: number;
  difference: number;
  percentDiff: number;
} {
  const newMethod = countTokens(text, model);
  const divisor = model ? getModelTokenDivisor(model) : 2.0;
  const oldMethod = Math.ceil(text.length / divisor);
  const difference = Math.abs(newMethod - oldMethod);
  const percentDiff = (difference / oldMethod) * 100;

  return { newMethod, oldMethod, difference, percentDiff };
}

/**
 * Clear token cache
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Get cache stats
 */
export function getTokenCacheStats(): { size: number; maxSize: number } {
  return {
    size: tokenCache.size,
    maxSize: CACHE_MAX_SIZE,
  };
}
