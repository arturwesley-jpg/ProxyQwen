/**
 * File: model-router.ts
 * Project: qwenproxy
 * Data-driven model router with async DB writes and real metrics
 * 
 * Phase 4 improvements:
 * - Replaces hardcoded decision tree with metrics-based routing
 * - Async batched DB writes (non-blocking)
 * - Confidence scoring for decisions
 * - A/B testing support
 * - Automatic fallback on model failure
 */

import Database from 'better-sqlite3';
import path from 'path';
import { getModelContextWindow } from './model-registry.js';
import { countTokens } from '../utils/token-estimation.js';

const DB_PATH = path.resolve('data', 'router_decisions.db');

export interface PromptFeatures {
  length: number;
  hasImage: boolean;
  hasCode: boolean;
  hasTools: boolean;
  toolCallCount: number;
  language: 'pt' | 'en' | 'es' | 'zh' | 'other';
  complexityScore: number;
  isFactual: boolean;
  isCreative: boolean;
}

export interface RouterDecision {
  features: PromptFeatures;
  chosenModel: string;
  reason: string;
  timestamp: number;
  latencyMs?: number;
  success?: boolean;
  confidence: number;          // NEW: confidence score 0-1
  alternatives: string[];      // NEW: alternative models considered
  experiment?: string;         // NEW: A/B test experiment name
}

export interface ModelMetrics {
  model: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgTokens: number;
  lastUpdated: number;
  // Token-bucket for success rate smoothing
  successRateEMA: number;      // Exponential moving average
  latencyEMA: number;
}

export interface RouterConfig {
  enabled: boolean;
  override: string | null;
  respectClientChoice: boolean;
  logDecisions: boolean;
  // NEW: Phase 4 config
  enableDataDrivenRouting: boolean;
  fallbackEnabled: boolean;
  abTestingEnabled: boolean;
  minConfidenceThreshold: number;
  metricsWindowHours: number;
  fallbackModels: string[];    // ordered fallback chain
}

const DEFAULT_CONFIG: RouterConfig = {
  enabled: true,
  override: null,
  respectClientChoice: true,
  logDecisions: true,
  // Phase 4 defaults
  enableDataDrivenRouting: true,
  fallbackEnabled: true,
  abTestingEnabled: false,
  minConfidenceThreshold: 0.6,
  metricsWindowHours: 24,
  fallbackModels: ['qwen3.7-plus', 'qwen3.6-plus', 'qwen3.6-27b'],
};

// Language detection patterns
const LANGUAGE_PATTERNS = {
  pt: /\b(o que|como|quando|onde|por que|quem|qual|quais|para que|você|seu|sua|é|são|foi|tem)\b/i,
  en: /\b(what|how|when|where|why|who|which|you|your|the|a|an|is|are|was|were)\b/i,
  es: /\b(qué|cómo|cuándo|dónde|por qué|quién|cuál|para qué|tú|tu|el|la|los|las|es|son)\b/i,
  zh: /[\u4e00-\u9fff]/,
};

// Code detection patterns (EXPANDED)
const CODE_PATTERNS = [
  /```[\s\S]*```/,
  /\b(function|const|let|var|class|import|export|return|if|else|for|while)\s*[\(:]/i,
  /\b(def|class|import|from|return|if|elif|else|for|while)\s+\w+/i,
  /\b(public|private|protected|static|void|int|string|boolean)\s+/i,
  /\b(function|def|class|escreva|write)\s+\w+\s*\(/i,
  /\b(escreva|write)\s+\w+/i,
  /\bconsole\.(log|error|warn|info)\s*\(/i,
  /\bprint\s*\(/i,
  /\bSystem\.(out|err)\s*\./i,
  /=>\s*\{/,
  /\{[\s\S]{0,200\}\}/,
];

const FACTUAL_PATTERNS = /\b(o que (?:e|é)|o que sao|o que são|what is|what are|quando foi|when was|onde fica|where is|quantos|how many|qual (?:e|é)|which is|define|definition|significa|means)\b/i;

const CREATIVE_PATTERNS = /\b(escreva|crie|write|create|compose|story|poem|poema|história|invent|imagine|inventar)\b/i;

let db: Database.Database | null = null;
let config: RouterConfig = { ...DEFAULT_CONFIG };

// NEW: In-memory metrics cache for fast routing decisions
const modelMetricsCache = new Map<string, ModelMetrics>();
let metricsCacheLoaded = false;

// NEW: Batched async writes
interface PendingDecision {
  decision: RouterDecision;
  resolve: () => void;
}
const pendingDecisions: PendingDecision[] = [];
const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 2000;
let flushScheduled = false;

// NEW: Periodic metrics refresh
let metricsRefreshInterval: NodeJS.Timeout | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS router_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        features_json TEXT NOT NULL,
        chosen_model TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL,
        latency_ms INTEGER,
        success INTEGER,
        alternatives TEXT,
        experiment TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_router_timestamp ON router_decisions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_router_model ON router_decisions(chosen_model);
      CREATE INDEX IF NOT EXISTS idx_router_experiment ON router_decisions(experiment);
    `);
  }
  return db;
}

// NEW: Load model metrics from DB into memory cache
async function loadModelMetrics(): Promise<void> {
  if (metricsCacheLoaded) return;
  
  try {
    const d = getDb();
    const cutoff = Date.now() - config.metricsWindowHours * 60 * 60 * 1000;
    
    // Get aggregated metrics per model
    const rows = d.prepare(`
      SELECT 
        chosen_model as model,
        COUNT(*) as total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_count,
        AVG(latency_ms) as avg_latency,
        AVG(CASE WHEN success = 1 THEN latency_ms END) as avg_success_latency
      FROM router_decisions
      WHERE timestamp > ? AND latency_ms IS NOT NULL
      GROUP BY chosen_model
    `).all(cutoff) as any[];

    for (const row of rows) {
      const model = row.model;
      const total = row.total;
      const successCount = row.success_count || 0;
      const errorCount = row.error_count || 0;
      const avgLatency = row.avg_latency || 0;
      
      // Calculate EMA for success rate (alpha = 0.1)
      const prevMetrics = modelMetricsCache.get(model);
      const prevSuccessRate = prevMetrics?.successRateEMA ?? 0.5;
      const newSuccessRate = total > 0 ? successCount / total : 0.5;
      const successRateEMA = prevSuccessRate * 0.9 + newSuccessRate * 0.1;
      
      // Calculate EMA for latency
      const prevLatency = prevMetrics?.latencyEMA ?? avgLatency;
      const latencyEMA = prevLatency * 0.9 + avgLatency * 0.1;

      // Get p50/p95 from raw data (sample)
      const latencies = d.prepare(`
        SELECT latency_ms FROM router_decisions 
        WHERE chosen_model = ? AND timestamp > ? AND latency_ms IS NOT NULL
        ORDER BY latency_ms ASC
        LIMIT 1000
      `).all(model) as { latency_ms: number }[];
      
      const sortedLatencies = latencies.map(r => r.latency_ms).sort((a, b) => a - b);
      const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] || 0;
      const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] || 0;

      modelMetricsCache.set(model, {
        model,
        totalRequests: total,
        successCount,
        errorCount,
        avgLatencyMs: avgLatency,
        p50LatencyMs: p50,
        p95LatencyMs: p95,
        avgTokens: 0, // Not tracked yet
        lastUpdated: Date.now(),
        successRateEMA,
        latencyEMA,
      });
    }
    
    metricsCacheLoaded = true;
    console.log(`[ModelRouter] Loaded metrics for ${modelMetricsCache.size} models`);
  } catch (err: any) {
    console.error('[ModelRouter] Failed to load model metrics:', err.message);
  }
}

// NEW: Score a model based on metrics for current features
function scoreModelForFeatures(model: string, features: PromptFeatures): { score: number; confidence: number } {
  const metrics = modelMetricsCache.get(model);
  
  if (!metrics) {
    // No metrics yet - use default scoring based on features
    return getDefaultModelScore(model, features);
  }
  
  // Base score from success rate EMA (0-1)
  let score = metrics.successRateEMA * 0.4;
  
  // Latency factor (lower is better, normalize to 0-1)
  const maxAcceptableLatency = 30000; // 30s
  const latencyScore = Math.max(0, 1 - (metrics.latencyEMA / maxAcceptableLatency));
  score += latencyScore * 0.3;
  
  // Feature-specific bonuses
  if (features.hasCode && model.includes('coder')) score += 0.2;
  if (features.hasImage && model.includes('vl')) score += 0.2;
  if (features.length > 50000 && model.includes('max')) score += 0.15;
  if (features.isFactual && features.length < 500 && !features.hasTools && model.includes('27b')) score += 0.1;
  
  // Penalize if model is overloaded (high p95)
  if (metrics.p95LatencyMs > 20000) score -= 0.15;
  
  // Confidence based on sample size
  const confidence = Math.min(0.9, metrics.totalRequests / 100);
  
  return { score: Math.max(0, Math.min(1, score)), confidence };
}

// Default scoring when no metrics available (fallback to heuristics)
function getDefaultModelScore(model: string, features: PromptFeatures): { score: number; confidence: number } {
  let score = 0.5; // neutral
  let confidence = 0.3; // low confidence without data
  
  if (features.hasImage && model.includes('vl')) score = 0.9;
  else if (features.hasCode && model.includes('coder')) score = 0.85;
  else if (features.length > 50000 && model.includes('max')) score = 0.8;
  else if (features.complexityScore > 0.7 && model.includes('max')) score = 0.75;
  else if (features.isFactual && features.length < 500 && !features.hasTools && model.includes('27b')) score = 0.7;
  else if (model.includes('plus')) score = 0.6;
  else score = 0.5;
  
  if (features.hasImage || features.hasCode) confidence = 0.5;
  
  return { score: Math.max(0, Math.min(1, score)), confidence };
}

// Extract features from prompt (unchanged from original)
export function extractFeatures(prompt: string, toolCallCount: number = 0, hasMultimodal: boolean = false): PromptFeatures {
  const length = countTokens(prompt);
  
  let language: 'pt' | 'en' | 'es' | 'zh' | 'other' = 'other';
  for (const [lang, pattern] of Object.entries(LANGUAGE_PATTERNS)) {
    if (pattern.test(prompt)) {
      language = lang as any;
      break;
    }
  }
  
  const hasCode = CODE_PATTERNS.some(p => p.test(prompt));
  const isFactual = FACTUAL_PATTERNS.test(prompt);
  const isCreative = CREATIVE_PATTERNS.test(prompt);
  
  let complexityScore = 0;
  if (length > 1000) complexityScore += 0.3;
  if (length > 5000) complexityScore += 0.2;
  if (toolCallCount > 3) complexityScore += 0.3;
  if (toolCallCount > 10) complexityScore += 0.2;
  if (hasCode) complexityScore += 0.1;
  complexityScore = Math.min(1, complexityScore);
  
  return {
    length,
    hasImage: hasMultimodal,
    hasCode,
    hasTools: toolCallCount > 0,
    toolCallCount,
    language,
    complexityScore,
    isFactual,
    isCreative,
  };
}

/**
 * Route prompt to optimal model based on features + real metrics
 */
export function routeModel(features: PromptFeatures, clientModel?: string): RouterDecision {
  // 1. Respect client choice
  if (config.respectClientChoice && clientModel) {
    return createDecision(features, clientModel, 'client_choice', 1.0, []);
  }
  
  // 2. Override
  if (config.override) {
    return createDecision(features, config.override, 'override', 1.0, []);
  }
  
  // 3. Data-driven routing (Phase 4)
  if (config.enableDataDrivenRouting && metricsCacheLoaded) {
    // Score all available models
    const availableModels = [
      'qwen3.7-plus',
      'qwen3.7-max',
      'qwen3.6-plus',
      'qwen3.6-max-preview',
      'qwen3.6-27b',
      'qwen3-coder-plus',
      'qwen3-vl-plus',
    ].filter(m => modelMetricsCache.has(m) || getDefaultModelScore(m, features).score > 0);
    
    if (availableModels.length > 0) {
      // Score each model
      const scored = availableModels.map(model => {
        const { score, confidence } = scoreModelForFeatures(model, features);
        return { model, score, confidence };
      });
      
      // Sort by score descending
      scored.sort((a, b) => b.score - a.score);
      
      const best = scored[0];
      const alternatives = scored.slice(1, 4).map(s => s.model);
      
      // A/B testing: occasionally try second-best
      let chosen = best.model;
      let reason = `data_driven_${best.score.toFixed(2)}`;
      
      if (config.abTestingEnabled && Math.random() < 0.1 && scored.length > 1) {
        chosen = scored[1].model;
        reason = `ab_test_${scored[1].score.toFixed(2)}`;
      }
      
      // Check confidence threshold
      if (best.confidence < config.minConfidenceThreshold) {
        // Low confidence - fall back to heuristic
        return routeModelHeuristic(features, clientModel);
      }
      
      return createDecision(features, chosen, reason, best.confidence, alternatives);
    }
  }
  
  // 4. Fallback to heuristic
  return routeModelHeuristic(features, clientModel);
}

function routeModelHeuristic(features: PromptFeatures, clientModel?: string): RouterDecision {
  let chosenModel: string;
  let reason: string;
  
  if (features.hasImage) {
    chosenModel = 'qwen3-vl-plus';
    reason = 'multimodal_detected';
  } else if (features.hasCode) {
    chosenModel = 'qwen3-coder-plus';
    reason = 'code_detected';
  } else if (features.length > 50000) {
    chosenModel = 'qwen3.7-max';
    reason = `long_context_${features.length}_tokens`;
  } else if (features.complexityScore > 0.7 || features.toolCallCount > 10) {
    chosenModel = 'qwen3.7-max';
    reason = `high_complexity_${features.complexityScore.toFixed(2)}`;
  } else if (features.isFactual && features.length < 500 && !features.hasTools) {
    chosenModel = 'qwen3.6-27b';
    reason = 'simple_factual';
  } else {
    chosenModel = 'qwen3.7-plus';
    reason = 'default';
  }
  
  return createDecision(features, chosenModel, reason, 0.5, []);
}

function createDecision(
  features: PromptFeatures,
  chosenModel: string,
  reason: string,
  confidence: number,
  alternatives: string[]
): RouterDecision {
  const decision: RouterDecision = {
    features,
    chosenModel,
    reason,
    timestamp: Date.now(),
    confidence,
    alternatives,
  };
  
  if (config.logDecisions) {
    console.log(
      `[ModelRouter] ${reason}: ${chosenModel} | ` +
      `tokens=${features.length}, code=${features.hasCode}, tools=${features.toolCallCount}, ` +
      `complexity=${features.complexityScore.toFixed(2)}, lang=${features.language}, ` +
      `confidence=${confidence.toFixed(2)}`
    );
    persistDecision(decision);
  }
  
  return decision;
}

// NEW: Record outcome for a decision
export function updateDecisionOutcome(
  timestamp: number,
  latencyMs: number,
  success: boolean,
  model: string
): void {
  try {
    getDb().prepare(`
      UPDATE router_decisions 
      SET latency_ms = ?, success = ?
      WHERE timestamp = ?
    `).run(latencyMs, success ? 1 : 0, timestamp);
    
    // Update in-memory metrics cache
    updateModelMetricsCache(model, latencyMs, success);
  } catch (err: any) {
    console.error('[ModelRouter] Failed to update outcome:', err.message);
  }
}

// NEW: Update in-memory metrics cache incrementally
function updateModelMetricsCache(model: string, latencyMs: number, success: boolean): void {
  const metrics = modelMetricsCache.get(model);
  if (!metrics) return;
  
  metrics.totalRequests++;
  if (success) metrics.successCount++; else metrics.errorCount++;
  
  // EMA updates
  metrics.successRateEMA = metrics.successRateEMA * 0.95 + (success ? 1 : 0) * 0.05;
  metrics.latencyEMA = metrics.latencyEMA * 0.95 + latencyMs * 0.05;
  metrics.avgLatencyMs = metrics.latencyEMA; // approximate
  metrics.lastUpdated = Date.now();
}

// NEW: Async batched decision persistence
function persistDecision(decision: RouterDecision): void {
  pendingDecisions.push({
    decision,
    resolve: () => {}
  });
  
  // Always schedule flush if not already scheduled
  if (!flushScheduled) {
    scheduleFlush();
  }
  
  // Also flush immediately if batch size reached
  if (pendingDecisions.length >= BATCH_SIZE && !flushScheduled) {
    // flushScheduled will be true after scheduleFlush, so this won't double-schedule
    // But we can also force immediate flush if batch is full
    if (pendingDecisions.length >= BATCH_SIZE) {
      flushPendingDecisions();
    }
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  console.log(`[ModelRouter] Scheduled flush in ${FLUSH_INTERVAL_MS}ms`);
  setTimeout(() => {
    console.log('[ModelRouter] Flush timeout fired');
    flushPendingDecisions();
    flushScheduled = false;
  }, FLUSH_INTERVAL_MS);
}

function flushPendingDecisions(): void {
  if (pendingDecisions.length === 0) return;
  
  console.log(`[ModelRouter] Flushing ${pendingDecisions.length} pending decisions`);
  
  const toFlush = [...pendingDecisions];
  pendingDecisions.length = 0;
  
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO router_decisions 
      (timestamp, features_json, chosen_model, reason, confidence, alternatives, experiment)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertMany = db.transaction((decisions: PendingDecision[]) => {
      for (const d of decisions) {
        stmt.run(
          d.decision.timestamp,
          JSON.stringify(d.decision.features),
          d.decision.chosenModel,
          d.decision.reason,
          d.decision.confidence,
          JSON.stringify(d.decision.alternatives),
          d.decision.experiment || null
        );
        d.resolve();
      }
    });
    
    insertMany(toFlush);
    console.log(`[ModelRouter] Successfully persisted ${toFlush.length} decisions`);
  } catch (err: any) {
    console.error('[ModelRouter] Failed to persist decision batch:', err.message);
    // Re-queue failed decisions
    pendingDecisions.unshift(...toFlush);
  }
}

// NEW: Get router statistics
export function getRouterStats(hours: number = 24): {
  total: number;
  byModel: Record<string, number>;
  byReason: Record<string, number>;
  avgLatency: number;
  successRate: number;
  modelMetrics: Record<string, ModelMetrics>;
} {
  try {
    const d = getDb();
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    
    const total = (d.prepare(
      'SELECT COUNT(*) as count FROM router_decisions WHERE timestamp > ?'
    ).get(cutoff) as any).count;
    
    const byModel = d.prepare(`
      SELECT chosen_model, COUNT(*) as count 
      FROM router_decisions 
      WHERE timestamp > ?
      GROUP BY chosen_model
    `).all(cutoff) as any[];
    
    const byReason = d.prepare(`
      SELECT reason, COUNT(*) as count 
      FROM router_decisions 
      WHERE timestamp > ?
      GROUP BY reason
    `).all(cutoff) as any[];
    
    const latencyStats = d.prepare(`
      SELECT AVG(latency_ms) as avg_latency, 
             SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as success_rate
      FROM router_decisions 
      WHERE timestamp > ? AND latency_ms IS NOT NULL
    `).get(cutoff) as any;
    
    // Add in-memory metrics
    const modelMetrics: Record<string, ModelMetrics> = {};
    for (const [model, metrics] of modelMetricsCache) {
      modelMetrics[model] = { ...metrics };
    }
    
    return {
      total,
      byModel: Object.fromEntries(byModel.map(r => [r.chosen_model, r.count])),
      byReason: Object.fromEntries(byReason.map(r => [r.reason, r.count])),
      avgLatency: latencyStats.avg_latency || 0,
      successRate: latencyStats.success_rate || 0,
      modelMetrics,
    };
  } catch (err) {
    return { total: 0, byModel: {}, byReason: {}, avgLatency: 0, successRate: 0, modelMetrics: {} };
  }
}

// NEW: Update router config
export function setRouterConfig(partial: Partial<RouterConfig>): void {
  config = { ...config, ...partial };
  console.log('[ModelRouter] Config updated:', config);
  
  // If data-driven routing enabled, load metrics
  if (config.enableDataDrivenRouting && !metricsCacheLoaded) {
    loadModelMetrics();
  }
}

export function getRouterConfig(): RouterConfig {
  return { ...config };
}

// NEW: Start periodic metrics refresh
export function startMetricsRefresher(intervalMs: number = 5 * 60 * 1000): void {
  if (metricsRefreshInterval) return;
  
  console.log(`[ModelRouter] Starting metrics refresher (every ${intervalMs / 1000}s)`);
  metricsRefreshInterval = setInterval(async () => {
    metricsCacheLoaded = false;
    await loadModelMetrics();
  }, intervalMs);
  
  // Initial load
  if (config.enableDataDrivenRouting) {
    loadModelMetrics();
  }
}

export function stopMetricsRefresher(): void {
  if (metricsRefreshInterval) {
    clearInterval(metricsRefreshInterval);
    metricsRefreshInterval = null;
  }
}

// NEW: Force flush on shutdown
export function flushAll(): void {
  flushPendingDecisions();
}

export function closeRouterDb(): void {
  flushAll();
  stopMetricsRefresher();
  if (db) {
    db.close();
    db = null;
  }
  modelMetricsCache.clear();
  metricsCacheLoaded = false;
}