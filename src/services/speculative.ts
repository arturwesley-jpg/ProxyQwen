/*
 * File: speculative.ts
 * Project: qwenproxy
 * Speculative parallel requests: fast no-thinking + slow thinking in background
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.resolve('data', 'speculative_results.db');

interface SpeculativeResult {
  id: string;
  timestamp: number;
  model: string;
  prompt_hash: string;
  fast_response: string;
  slow_response: string | null;
  similarity: number | null;
  diverged: boolean | null;
  fast_latency_ms: number;
  slow_latency_ms: number | null;
}

export interface SpeculativeConfig {
  enabled: boolean;
  threshold: number;  // cosine similarity threshold for divergence (default 0.7)
  timeout_ms: number; // max wait for shadow request (default 30000)
  log_divergences: boolean;
}

const DEFAULT_CONFIG: SpeculativeConfig = {
  enabled: false,
  threshold: 0.7,
  timeout_ms: 30000,
  log_divergences: true,
};

let db: Database.Database | null = null;
let config: SpeculativeConfig = { ...DEFAULT_CONFIG };

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS speculative_results (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        model TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        fast_response TEXT NOT NULL,
        slow_response TEXT,
        similarity REAL,
        diverged INTEGER,
        fast_latency_ms INTEGER NOT NULL,
        slow_latency_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_spec_model ON speculative_results(model);
      CREATE INDEX IF NOT EXISTS idx_spec_timestamp ON speculative_results(timestamp);
      CREATE INDEX IF NOT EXISTS idx_spec_diverged ON speculative_results(diverged);
    `);
  }
  return db;
}

/**
 * Similarity metric combining Jaccard + bigram overlap + length ratio
 * More robust than pure Jaccard for detecting semantic similarity
 */
export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  // Normalize
  const normA = a.toLowerCase().replace(/[^\w\s]/g, ' ');
  const normB = b.toLowerCase().replace(/[^\w\s]/g, ' ');

  // Word-level Jaccard (including short words this time)
  const wordsA = new Set(normA.split(/\s+/).filter(w => w.length > 0));
  const wordsB = new Set(normB.split(/\s+/).filter(w => w.length > 0));

  let wordIntersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) wordIntersection++;
  }
  const wordUnion = wordsA.size + wordsB.size - wordIntersection;
  const jaccard = wordUnion === 0 ? 0 : wordIntersection / wordUnion;

  // Character bigram overlap (Dice coefficient) - catches similar phrasing
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };

  const bgA = bigrams(normA);
  const bgB = bigrams(normB);

  let bigramIntersection = 0;
  for (const [bg, count] of bgA) {
    const other = bgB.get(bg);
    if (other) bigramIntersection += Math.min(count, other);
  }

  let bgTotalA = 0, bgTotalB = 0;
  for (const c of bgA.values()) bgTotalA += c;
  for (const c of bgB.values()) bgTotalB += c;

  const dice = (bgTotalA + bgTotalB) === 0 ? 0 : (2 * bigramIntersection) / (bgTotalA + bgTotalB);

  // Length ratio penalty (very different lengths = less similar)
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);

  // Weighted combination
  return 0.4 * jaccard + 0.4 * dice + 0.2 * lenRatio;
}

/**
 * Hash prompt for storage (don't store full prompts for privacy)
 */
function hashPrompt(prompt: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < prompt.length; i++) {
    hash ^= prompt.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Convert thinking model name to no-thinking variant
 */
export function toNoThinkingModel(model: string): string {
  if (model.includes('-no-thinking')) return model;
  return `${model}-no-thinking`;
}

/**
 * Check if model supports speculative execution
 */
export function supportsSpeculative(model: string): boolean {
  // Only thinking models benefit from speculative execution
  if (model.includes('-no-thinking')) return false;
  
  const supportedModels = [
    'qwen3.7-plus', 'qwen3.7-max',
    'qwen3.6-plus', 'qwen3.6-max-preview',
    'qwen3.5-plus',
  ];
  
  return supportedModels.some(m => model.includes(m));
}

/**
 * Run speculative parallel request
 * Returns fast response immediately, logs shadow result for training
 * 
 * @param fastRequest - Promise that resolves to fast (no-thinking) response
 * @param slowRequest - Promise that resolves to slow (thinking) response
 * @param model - Original model name
 * @param prompt - The prompt (for hashing)
 */
export async function speculativeExecute<T>(
  fastRequest: Promise<{ content: string; latencyMs: number }>,
  slowRequest: Promise<{ content: string; latencyMs: number }>,
  model: string,
  prompt: string
): Promise<{ content: string; latencyMs: number; speculative: boolean }> {
  if (!config.enabled || !supportsSpeculative(model)) {
    // Just return fast request result
    const fastResult = await fastRequest;
    return { ...fastResult, speculative: false };
  }

  const promptHash = hashPrompt(prompt);
  const id = `spec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const startTime = Date.now();

  // Race: return fast response immediately
  const fastResult = await fastRequest;
  const fastLatency = Date.now() - startTime;

  // Shadow: let slow request complete in background for training data
  slowRequest
    .then(slowResult => {
      const slowLatency = Date.now() - startTime;
      const similarity = textSimilarity(fastResult.content, slowResult.content);
      const diverged = similarity < config.threshold;

      if (diverged && config.log_divergences) {
        console.log(
          `[Speculative] Divergence detected: model=${model}, similarity=${similarity.toFixed(3)}, ` +
          `fast=${fastLatency}ms, slow=${slowLatency}ms`
        );
      }

      // Store for future router training
      try {
        getDb().prepare(`
          INSERT OR REPLACE INTO speculative_results
          (id, timestamp, model, prompt_hash, fast_response, slow_response, similarity, diverged, fast_latency_ms, slow_latency_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, Date.now(), model, promptHash,
          fastResult.content.slice(0, 5000),  // Truncate for storage
          slowResult.content.slice(0, 5000),
          similarity,
          diverged ? 1 : 0,
          fastLatency,
          slowLatency
        );
      } catch (err: any) {
        console.error('[Speculative] Failed to store result:', err.message);
      }
    })
    .catch(err => {
      console.warn('[Speculative] Shadow request failed:', (err as Error).message);
    });

  return { ...fastResult, latencyMs: fastLatency, speculative: true };
}

/**
 * Update speculative config
 */
export function setSpeculativeConfig(partial: Partial<SpeculativeConfig>): void {
  config = { ...config, ...partial };
  console.log('[Speculative] Config updated:', config);
}

/**
 * Get current config
 */
export function getSpeculativeConfig(): SpeculativeConfig {
  return { ...config };
}

/**
 * Get divergence statistics by model (for router training)
 */
export function getDivergenceStats(model?: string): {
  total: number;
  diverged: number;
  divergenceRate: number;
  avgSimilarity: number;
  avgFastLatency: number;
  avgSlowLatency: number;
} {
  try {
    const d = getDb();
    const where = model ? 'WHERE model = ?' : '';
    const params = model ? [model] : [];

    const row = d.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(diverged) as diverged,
        AVG(similarity) as avg_similarity,
        AVG(fast_latency_ms) as avg_fast_latency,
        AVG(slow_latency_ms) as avg_slow_latency
      FROM speculative_results ${where}
    `).get(...params) as any;

    const total = row.total || 0;
    return {
      total,
      diverged: row.diverged || 0,
      divergenceRate: total > 0 ? (row.diverged || 0) / total : 0,
      avgSimilarity: row.avg_similarity || 0,
      avgFastLatency: row.avg_fast_latency || 0,
      avgSlowLatency: row.avg_slow_latency || 0,
    };
  } catch (err) {
    return { total: 0, diverged: 0, divergenceRate: 0, avgSimilarity: 0, avgFastLatency: 0, avgSlowLatency: 0 };
  }
}

/**
 * Close DB connection
 */
export function closeSpeculativeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
