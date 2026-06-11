/*
 * File: index.bun.ts
 * Project: qwenproxy
 * Bun-specific entry point with optimized SQLite and runtime detection
 */

import { startServer } from './api/server.js';

// Bun runtime detection
const isBun = typeof (globalThis as any).Bun !== 'undefined';

if (isBun) {
  console.log(`[Bun] Running on Bun ${(globalThis as any).Bun.version}`);
  
  // Bun-specific optimizations
  if ((globalThis as any).Bun.gc) {
    // Enable aggressive GC for Bun
    setInterval(() => {
      (globalThis as any).Bun.gc(true);
    }, 30000);
  }
} else {
  console.log('[Bun] Warning: index.bun.ts loaded in non-Bun runtime, falling back to Node behavior');
}

startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
