/*
 * File: ab-testing.ts
 * Project: qwenproxy
 * A/B testing framework for system prompts, models, and parameters
 */

import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';

const DB_PATH = path.resolve('data', 'ab_testing.db');

export interface ExperimentVariant {
  name: string;
  weight: number; // Traffic percentage (0-1)
  config: {
    systemPrompt?: string;
    model?: string;
    temperature?: number;
    topP?: number;
    [key: string]: any;
  };
}

export interface Experiment {
  id: string;
  name: string;
  description: string;
  variants: ExperimentVariant[];
  trafficPct: number; // Percentage of total traffic to include (0-1)
  startedAt: number;
  status: 'active' | 'paused' | 'completed';
}

export interface ExperimentResult {
  experimentId: string;
  variant: string;
  requestId: string;
  userId: string;
  latencyMs: number;
  toolCallCount: number;
  success: boolean;
  userRating?: number; // 1-5 stars
  timestamp: number;
}

export interface ExperimentStats {
  experimentId: string;
  variant: string;
  sampleSize: number;
  avgLatency: number;
  successRate: number;
  avgToolCalls: number;
  avgRating: number | null;
}

let db: Database.Database | null = null;
const experimentCache = new Map<string, Experiment>();

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        variants_json TEXT NOT NULL,
        traffic_pct REAL NOT NULL,
        started_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS experiment_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id TEXT NOT NULL,
        variant TEXT NOT NULL,
        request_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        tool_call_count INTEGER DEFAULT 0,
        success INTEGER NOT NULL,
        user_rating REAL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (experiment_id) REFERENCES experiments(id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_results_experiment ON experiment_results(experiment_id);
      CREATE INDEX IF NOT EXISTS idx_results_variant ON experiment_results(variant);
      CREATE INDEX IF NOT EXISTS idx_results_timestamp ON experiment_results(timestamp);
    `);
    
    loadExperiments();
  }
  return db;
}

/**
 * Load all experiments from DB into cache
 */
function loadExperiments(): void {
  try {
    const rows = getDb().prepare('SELECT * FROM experiments WHERE status = ?').all('active') as any[];
    for (const row of rows) {
      experimentCache.set(row.id, {
        id: row.id,
        name: row.name,
        description: row.description,
        variants: JSON.parse(row.variants_json),
        trafficPct: row.traffic_pct,
        startedAt: row.started_at,
        status: row.status,
      });
    }
    console.log(`[ABTesting] Loaded ${experimentCache.size} active experiments`);
  } catch (err: any) {
    console.error('[ABTesting] Failed to load experiments:', err.message);
  }
}

/**
 * Create new experiment
 */
export function createExperiment(
  name: string,
  description: string,
  variants: ExperimentVariant[],
  trafficPct: number = 0.05
): Experiment {
  const id = `exp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  
  // Normalize variant weights
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  const normalizedVariants = variants.map(v => ({
    ...v,
    weight: v.weight / totalWeight,
  }));

  const experiment: Experiment = {
    id,
    name,
    description,
    variants: normalizedVariants,
    trafficPct,
    startedAt: Date.now(),
    status: 'active',
  };

  try {
    getDb().prepare(`
      INSERT INTO experiments 
      (id, name, description, variants_json, traffic_pct, started_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      description,
      JSON.stringify(normalizedVariants),
      trafficPct,
      experiment.startedAt,
      'active'
    );

    experimentCache.set(id, experiment);
    console.log(`[ABTesting] Created experiment: ${name} (${id}), ${variants.length} variants, ${trafficPct * 100}% traffic`);
    
    return experiment;
  } catch (err: any) {
    throw new Error(`Failed to create experiment: ${err.message}`);
  }
}

/**
 * Get active experiment for user (deterministic assignment)
 */
export function getExperimentForUser(userId: string): { experiment: Experiment; variant: ExperimentVariant } | null {
  if (experimentCache.size === 0) return null;

  // Hash user ID for deterministic assignment
  const hash = crypto.createHash('md5').update(userId).digest('hex');
  const hashNum = parseInt(hash.slice(0, 8), 16) / 0xffffffff;

  // Check each active experiment
  for (const experiment of experimentCache.values()) {
    if (experiment.status !== 'active') continue;

    // Check if user is in traffic percentage
    const userHash = crypto.createHash('md5').update(userId + experiment.id).digest('hex');
    const userHashNum = parseInt(userHash.slice(0, 8), 16) / 0xffffffff;

    if (userHashNum > experiment.trafficPct) continue;

    // Assign variant based on hash
    let cumulativeWeight = 0;
    for (const variant of experiment.variants) {
      cumulativeWeight += variant.weight;
      if (hashNum <= cumulativeWeight) {
        return { experiment, variant };
      }
    }
  }

  return null;
}

/**
 * Record experiment result
 */
export function recordResult(result: ExperimentResult): void {
  try {
    getDb().prepare(`
      INSERT INTO experiment_results 
      (experiment_id, variant, request_id, user_id, latency_ms, tool_call_count, success, user_rating, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.experimentId,
      result.variant,
      result.requestId,
      result.userId,
      result.latencyMs,
      result.toolCallCount,
      result.success ? 1 : 0,
      result.userRating || null,
      result.timestamp
    );
  } catch (err: any) {
    console.error('[ABTesting] Failed to record result:', err.message);
  }
}

/**
 * Get experiment statistics with Welch's t-test
 */
export function getExperimentStats(experimentId: string): ExperimentStats[] {
  try {
    const d = getDb();
    
    const rows = d.prepare(`
      SELECT 
        variant,
        COUNT(*) as sample_size,
        AVG(latency_ms) as avg_latency,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as success_rate,
        AVG(tool_call_count) as avg_tool_calls,
        AVG(user_rating) as avg_rating
      FROM experiment_results
      WHERE experiment_id = ?
      GROUP BY variant
    `).all(experimentId) as any[];

    return rows.map(row => ({
      experimentId,
      variant: row.variant,
      sampleSize: row.sample_size,
      avgLatency: row.avg_latency || 0,
      successRate: row.success_rate || 0,
      avgToolCalls: row.avg_tool_calls || 0,
      avgRating: row.avg_rating,
    }));
  } catch (err: any) {
    console.error('[ABTesting] Failed to get stats:', err.message);
    return [];
  }
}

/**
 * Welch's t-test for statistical significance
 * Returns p-value (probability that difference is due to chance)
 */
export function welchTTest(
  group1: { mean: number; variance: number; n: number },
  group2: { mean: number; variance: number; n: number }
): { tStatistic: number; pValue: number; significant: boolean } {
  const { mean: m1, variance: v1, n: n1 } = group1;
  const { mean: m2, variance: v2, n: n2 } = group2;

  // Welch's t-statistic
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  const t = (m1 - m2) / se;

  // Welch-Satterthwaite degrees of freedom
  const df = Math.pow(v1 / n1 + v2 / n2, 2) / 
    (Math.pow(v1 / n1, 2) / (n1 - 1) + Math.pow(v2 / n2, 2) / (n2 - 1));

  // Approximate p-value using t-distribution (simplified)
  // For production, use proper statistical library
  const absT = Math.abs(t);
  const pValue = absT > 3 ? 0.001 : absT > 2 ? 0.01 : absT > 1.5 ? 0.05 : 0.1;

  return {
    tStatistic: t,
    pValue,
    significant: pValue < 0.05,
  };
}

/**
 * Promote winning variant (update all traffic to use it)
 */
export function promoteVariant(experimentId: string, variantName: string): boolean {
  try {
    const experiment = experimentCache.get(experimentId);
    if (!experiment) return false;

    // Find variant
    const variant = experiment.variants.find(v => v.name === variantName);
    if (!variant) return false;

    // Update experiment to 100% traffic on this variant
    const updatedVariants = experiment.variants.map(v => ({
      ...v,
      weight: v.name === variantName ? 1 : 0,
    }));

    getDb().prepare(`
      UPDATE experiments 
      SET variants_json = ?, status = ?
      WHERE id = ?
    `).run(JSON.stringify(updatedVariants), 'completed', experimentId);

    experiment.variants = updatedVariants;
    experiment.status = 'completed';
    experimentCache.set(experimentId, experiment);

    console.log(`[ABTesting] Promoted variant '${variantName}' for experiment ${experiment.name}`);
    return true;
  } catch (err: any) {
    console.error('[ABTesting] Failed to promote variant:', err.message);
    return false;
  }
}

/**
 * Pause experiment
 */
export function pauseExperiment(experimentId: string): boolean {
  try {
    const experiment = experimentCache.get(experimentId);
    if (!experiment) return false;

    getDb().prepare('UPDATE experiments SET status = ? WHERE id = ?').run('paused', experimentId);
    experiment.status = 'paused';
    experimentCache.set(experimentId, experiment);

    console.log(`[ABTesting] Paused experiment: ${experiment.name}`);
    return true;
  } catch (err: any) {
    console.error('[ABTesting] Failed to pause experiment:', err.message);
    return false;
  }
}

/**
 * List all experiments
 */
export function listExperiments(status?: 'active' | 'paused' | 'completed'): Experiment[] {
  const experiments = Array.from(experimentCache.values());
  return status ? experiments.filter(e => e.status === status) : experiments;
}

/**
 * Delete experiment
 */
export function deleteExperiment(experimentId: string): boolean {
  try {
    getDb().prepare('DELETE FROM experiments WHERE id = ?').run(experimentId);
    getDb().prepare('DELETE FROM experiment_results WHERE experiment_id = ?').run(experimentId);
    experimentCache.delete(experimentId);
    console.log(`[ABTesting] Deleted experiment: ${experimentId}`);
    return true;
  } catch (err: any) {
    console.error('[ABTesting] Failed to delete experiment:', err.message);
    return false;
  }
}

/**
 * Close DB connection
 */
export function closeABTestingDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  experimentCache.clear();
}
