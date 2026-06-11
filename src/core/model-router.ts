/*
 * File: model-router.ts
 * Project: qwenproxy
 * Neural model router - selects optimal model based on prompt features
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
}

export interface RouterConfig {
  enabled: boolean;
  override: string | null; // Force specific model
  respectClientChoice: boolean;
  logDecisions: boolean;
}

const DEFAULT_CONFIG: RouterConfig = {
  enabled: true,
  override: null,
  respectClientChoice: true,
  logDecisions: true,
};

let db: Database.Database | null = null;
let config: RouterConfig = { ...DEFAULT_CONFIG };

// Language detection patterns
const LANGUAGE_PATTERNS = {
  pt: /\b(o que|como|quando|onde|por que|quem|qual|quais|para que|você|seu|sua|é|são|foi|tem)\b/i,
  en: /\b(what|how|when|where|why|who|which|you|your|the|a|an|is|are|was|were)\b/i,
  es: /\b(qué|cómo|cuándo|dónde|por qué|quién|cuál|para qué|tú|tu|el|la|los|las|es|son)\b/i,
  zh: /[一-鿿]/,
};

// Code detection patterns (EXPANDED for better coverage)
const CODE_PATTERNS = [
  /```[\s\S]*```/,
  /\b(function|const|let|var|class|import|export|return|if|else|for|while)\s*[\(:]/i,
  /\b(def|class|import|from|return|if|elif|else|for|while)\s+\w+/i,
  /\b(public|private|protected|static|void|int|string|boolean)\s+/i,
  /\b(function|def|class|escreva|write)\s+\w+\s*\(/i,
  /\bconsole\.(log|error|warn|info)\s*\(/i,
  /\bprint\s*\(/i,
  /\bSystem\.(out|err)\s*\./i,
  /=>\s*\{/,
  /\{[\s\S]{0,200}\}/,
];

// Factual question patterns (EXPANDED for PT/EN/ES)
const FACTUAL_PATTERNS = /\b(o que é|o que sao|o que são|who is|what is|what are|quando foi|when was|onde fica|where is|quantos|how many|qual é|which is|define|definition|significa|means)\b/i;

// Creative patterns
const CREATIVE_PATTERNS = /\b(escreva|crie|write|create|compose|story|poem|poema|história|invent|imagine|inventar)\b/i;

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
        latency_ms INTEGER,
        success INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_router_timestamp ON router_decisions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_router_model ON router_decisions(chosen_model);
    `);
  }
  return db;
}

/**
 * Extract features from prompt for routing decision
 */
export function extractFeatures(prompt: string, toolCallCount: number = 0, hasMultimodal: boolean = false): PromptFeatures {
  const length = countTokens(prompt);
  
  // Language detection
  let language: 'pt' | 'en' | 'es' | 'zh' | 'other' = 'other';
  for (const [lang, pattern] of Object.entries(LANGUAGE_PATTERNS)) {
    if (pattern.test(prompt)) {
      language = lang as any;
      break;
    }
  }

  // Code detection
  const hasCode = CODE_PATTERNS.some(p => p.test(prompt));

  // Factual detection
  const isFactual = FACTUAL_PATTERNS.test(prompt);

  // Creative detection
  const isCreative = CREATIVE_PATTERNS.test(prompt);

  // Complexity score (0-1)
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
 * Route prompt to optimal model based on features
 */
export function routeModel(features: PromptFeatures, clientModel?: string): RouterDecision {
  // Respect client choice if configured
  if (config.respectClientChoice && clientModel) {
    return {
      features,
      chosenModel: clientModel,
      reason: 'client_choice',
      timestamp: Date.now(),
    };
  }

  // Override if configured
  if (config.override) {
    return {
      features,
      chosenModel: config.override,
      reason: 'override',
      timestamp: Date.now(),
    };
  }

  // Decision tree
  let chosenModel: string;
  let reason: string;

  // 1. Multimodal → vision model
  if (features.hasImage) {
    chosenModel = 'qwen3-vl-plus';
    reason = 'multimodal_detected';
  }
  // 2. Code → coder model
  else if (features.hasCode) {
    chosenModel = 'qwen3-coder-plus';
    reason = 'code_detected';
  }
  // 3. Very long context → max model
  else if (features.length > 50000) {
    chosenModel = 'qwen3.7-max';
    reason = `long_context_${features.length}_tokens`;
  }
  // 4. High complexity → max model
  else if (features.complexityScore > 0.7 || features.toolCallCount > 10) {
    chosenModel = 'qwen3.7-max';
    reason = `high_complexity_${features.complexityScore.toFixed(2)}`;
  }
  // 5. Simple factual → fast model
  else if (features.isFactual && features.length < 500 && !features.hasTools) {
    chosenModel = 'qwen3.6-27b';
    reason = 'simple_factual';
  }
  // 6. Default → plus model
  else {
    chosenModel = 'qwen3.7-plus';
    reason = 'default';
  }

  const decision: RouterDecision = {
    features,
    chosenModel,
    reason,
    timestamp: Date.now(),
  };

  // Log decision
  if (config.logDecisions) {
    console.log(
      `[ModelRouter] ${reason}: ${chosenModel} | ` +
      `tokens=${features.length}, code=${features.hasCode}, tools=${features.toolCallCount}, ` +
      `complexity=${features.complexityScore.toFixed(2)}, lang=${features.language}`
    );
    persistDecision(decision);
  }

  return decision;
}

/**
 * Persist router decision for future analysis (batched async writes)
 */
let pendingDecisions: RouterDecision[] = [];
let flushScheduled = false;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5000;

function persistDecision(decision: RouterDecision): void {
  pendingDecisions.push(decision);
  
  if (pendingDecisions.length >= BATCH_SIZE && !flushScheduled) {
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    flushPendingDecisions();
    flushScheduled = false;
  }, FLUSH_INTERVAL_MS);
}

function flushPendingDecisions(): void {
  if (pendingDecisions.length === 0) return;
  
  const toFlush = [...pendingDecisions];
  pendingDecisions = [];
  
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO router_decisions 
      (timestamp, features_json, chosen_model, reason, latency_ms, success)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const insertMany = db.transaction((decisions: RouterDecision[]) => {
      for (const d of decisions) {
        stmt.run(
          d.timestamp,
          JSON.stringify(d.features),
          d.chosenModel,
          d.reason,
          d.latencyMs || null,
          d.success !== undefined ? (d.success ? 1 : 0) : null
        );
      }
    });
    
    insertMany(toFlush);
  } catch (err: any) {
    console.error('[ModelRouter] Failed to persist decision batch:', err.message);
  }
}

/**
 * Update decision with outcome (latency, success)
 */
export function updateDecisionOutcome(
  timestamp: number,
  latencyMs: number,
  success: boolean
): void {
  try {
    getDb().prepare(`
      UPDATE router_decisions 
      SET latency_ms = ?, success = ?
      WHERE timestamp = ?
    `).run(latencyMs, success ? 1 : 0, timestamp);
  } catch (err: any) {
    console.error('[ModelRouter] Failed to update outcome:', err.message);
  }
}

/**
 * Get router statistics
 */
export function getRouterStats(hours: number = 24): {
  total: number;
  byModel: Record<string, number>;
  byReason: Record<string, number>;
  avgLatency: number;
  successRate: number;
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

    return {
      total,
      byModel: Object.fromEntries(byModel.map(r => [r.chosen_model, r.count])),
      byReason: Object.fromEntries(byReason.map(r => [r.reason, r.count])),
      avgLatency: latencyStats.avg_latency || 0,
      successRate: latencyStats.success_rate || 0,
    };
  } catch (err) {
    return { total: 0, byModel: {}, byReason: {}, avgLatency: 0, successRate: 0 };
  }
}

/**
 * Update router config
 */
export function setRouterConfig(partial: Partial<RouterConfig>): void {
  config = { ...config, ...partial };
  console.log('[ModelRouter] Config updated:', config);
}

/**
 * Get current config
 */
export function getRouterConfig(): RouterConfig {
  return { ...config };
}

/**
 * Close DB connection
 */
export function closeRouterDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
