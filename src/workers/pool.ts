/*
 * File: pool.ts
 * Project: qwenproxy
 * Worker thread pool for SSE parsing offload
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'sse-parser.worker.ts');

interface PendingRequest {
  resolve: (events: any[]) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

interface WorkerEntry {
  worker: Worker;
  busy: boolean;
  ready: boolean;
  parsesCompleted: number;
}

const PARSE_TIMEOUT_MS = 5000;
const MAX_WORKERS = 4;

/**
 * Detect runtime capabilities
 */
function detectRuntime(): { hasWorkerThreads: boolean; isBun: boolean } {
  const isBun = typeof (globalThis as any).Bun !== 'undefined';
  let hasWorkerThreads = false;
  try {
    require('worker_threads');
    hasWorkerThreads = true;
  } catch {
    hasWorkerThreads = false;
  }
  return { hasWorkerThreads, isBun };
}

/**
 * Inline SSE parser fallback (runs on main thread when workers unavailable)
 */
function parseSSEInline(chunks: string[]): any[] {
  const events: any[] = [];
  const buffer = chunks.join('');
  const lines = buffer.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data: ')) continue;

    const dataStr = trimmed.slice(6);
    if (dataStr === '[DONE]') {
      events.push({ type: 'done', data: null });
      continue;
    }

    try {
      const chunk = JSON.parse(dataStr);

      if (chunk['response.created']?.response_id) {
        events.push({ type: 'response_created', data: { responseId: chunk['response.created'].response_id } });
      }
      if (chunk.usage) {
        events.push({ type: 'usage', data: { inputTokens: chunk.usage.input_tokens, outputTokens: chunk.usage.output_tokens } });
      }
      if (chunk.choices?.[0]?.delta) {
        const delta = chunk.choices[0].delta;
        if (delta.phase === 'thinking_summary' && delta.extra?.summary_thought?.content) {
          events.push({ type: 'thinking', data: { thoughts: delta.extra.summary_thought.content } });
        } else if (typeof delta.content === 'string' && delta.content.length > 0 && delta.content !== 'FINISHED') {
          events.push({ type: 'content', data: { content: delta.content } });
        }
      }
    } catch {}
  }

  return events;
}

export class WorkerPool {
  private static instance: WorkerPool | null = null;
  private workers: WorkerEntry[] = [];
  private pending = new Map<string, PendingRequest>();
  private queue: Array<{ chunks: string[]; resolve: (events: any[]) => void; reject: (err: Error) => void }> = [];
  private size: number;
  private initialized = false;
  private useFallback = false;

  // Metrics
  private metrics = {
    parsesTotal: 0,
    fallbacksTotal: 0,
    errorsTotal: 0,
    queueDepth: 0,
  };

  private constructor(size?: number) {
    const cpus = os.cpus().length;
    this.size = size || Math.max(1, Math.min(cpus - 1, MAX_WORKERS));
  }

  static getInstance(size?: number): WorkerPool {
    if (!WorkerPool.instance) {
      WorkerPool.instance = new WorkerPool(size);
    }
    return WorkerPool.instance;
  }

  /**
   * Lazy initialization - workers only spawn on first use
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const runtime = detectRuntime();
    if (runtime.isBun || !runtime.hasWorkerThreads) {
      console.log('[WorkerPool] Running in fallback mode (Bun or no worker_threads)');
      this.useFallback = true;
      this.initialized = true;
      return;
    }

    try {
      for (let i = 0; i < this.size; i++) {
        const worker = new Worker(WORKER_PATH, {
          execArgv: ['--import', 'tsx'],
        });

        const entry: WorkerEntry = {
          worker,
          busy: false,
          ready: false,
          parsesCompleted: 0,
        };

        worker.on('message', (msg: any) => {
          if (msg.type === 'ready') {
            entry.ready = true;
            this.processQueue();
            return;
          }

          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pending.delete(msg.id);
            entry.busy = false;
            entry.parsesCompleted++;

            if (msg.type === 'error') {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.events || []);
            }
            this.processQueue();
          }
        });

        worker.on('error', (err: Error) => {
          console.error(`[WorkerPool] Worker error:`, err?.message || err);
          this.metrics.errorsTotal++;
        });

        worker.on('exit', (code) => {
          if (code !== 0) {
            console.warn(`[WorkerPool] Worker exited with code ${code}`);
          }
        });

        this.workers.push(entry);
      }

      // Wait up to 5s for all workers to be ready
      const deadline = Date.now() + 5000;
      while (this.workers.some(w => !w.ready) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }

      const readyCount = this.workers.filter(w => w.ready).length;
      if (readyCount === 0) {
        console.warn('[WorkerPool] No workers ready, falling back to main thread');
        this.useFallback = true;
      } else {
        console.log(`[WorkerPool] ${readyCount}/${this.size} workers ready`);
      }

      this.initialized = true;
    } catch (err: any) {
      console.error('[WorkerPool] Init failed, using fallback:', err.message);
      this.useFallback = true;
      this.initialized = true;
    }
  }

  /**
   * Parse SSE chunks - returns events array
   */
  async parse(chunks: string[]): Promise<any[]> {
    await this.ensureInitialized();

    this.metrics.parsesTotal++;

    // Fallback path
    if (this.useFallback) {
      this.metrics.fallbacksTotal++;
      return parseSSEInline(chunks);
    }

    return new Promise<any[]>((resolve, reject) => {
      this.queue.push({ chunks, resolve, reject });
      this.metrics.queueDepth = this.queue.length;
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;

    const freeWorker = this.workers.find(w => w.ready && !w.busy);
    if (!freeWorker) return;

    const job = this.queue.shift()!;
    this.metrics.queueDepth = this.queue.length;

    const id = crypto.randomUUID();
    freeWorker.busy = true;

    const timeout = setTimeout(() => {
      this.pending.delete(id);
      freeWorker.busy = false;
      this.metrics.fallbacksTotal++;
      console.warn('[WorkerPool] Parse timeout, using fallback');
      job.resolve(parseSSEInline(job.chunks));
      this.processQueue();
    }, PARSE_TIMEOUT_MS);

    this.pending.set(id, {
      resolve: job.resolve,
      reject: job.reject,
      timeout,
    });

    freeWorker.worker.postMessage({ type: 'parse', id, chunks: job.chunks });
  }

  /**
   * Get pool metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      workersTotal: this.workers.length,
      workersBusy: this.workers.filter(w => w.busy).length,
      workersReady: this.workers.filter(w => w.ready).length,
      pendingRequests: this.pending.size,
      useFallback: this.useFallback,
    };
  }

  /**
   * Graceful shutdown
   */
  async destroy(): Promise<void> {
    // Clear pending
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WorkerPool destroyed'));
    }
    this.pending.clear();

    // Terminate workers
    const terminationPromises = this.workers.map(w => w.worker.terminate());
    await Promise.all(terminationPromises);
    this.workers = [];
    this.initialized = false;
    WorkerPool.instance = null;
  }
}
