/*
 * File: runtime.ts
 * Project: qwenproxy
 * Runtime detection: Node.js vs Bun
 */

export interface RuntimeInfo {
  name: 'node' | 'bun';
  version: string;
  isBun: boolean;
  isNode: boolean;
  supportsWorkerThreads: boolean;
  supportsNativeSqlite: boolean;
}

let cachedRuntime: RuntimeInfo | null = null;

export function detectRuntime(): RuntimeInfo {
  if (cachedRuntime) return cachedRuntime;

  const isBun = typeof (globalThis as any).Bun !== 'undefined';
  const bunVersion = isBun ? (globalThis as any).Bun.version : '';
  const nodeVersion = typeof process !== 'undefined' ? process.version : '';

  let supportsWorkerThreads = false;
  try {
    if (!isBun) {
      require('worker_threads');
      supportsWorkerThreads = true;
    }
  } catch {}

  const supportsNativeSqlite = isBun; // bun:sqlite

  cachedRuntime = {
    name: isBun ? 'bun' : 'node',
    version: isBun ? bunVersion : nodeVersion,
    isBun,
    isNode: !isBun,
    supportsWorkerThreads,
    supportsNativeSqlite,
  };

  return cachedRuntime;
}

/**
 * Conditional import: returns bun:sqlite if on Bun, otherwise better-sqlite3
 */
export async function getSqliteModule(): Promise<any> {
  const runtime = detectRuntime();
  if (runtime.isBun) {
    // Dynamic import of bun:sqlite
    try {
      const mod = await import('bun:sqlite' as string);
      return mod;
    } catch {
      console.warn('[Runtime] bun:sqlite not available, falling back to better-sqlite3');
    }
  }
  // Node path
  const mod = await import('better-sqlite3');
  return mod.default || mod;
}
