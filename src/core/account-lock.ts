/*
 * File: account-lock.ts
 * Project: qwenproxy
 * Per-account concurrency lock for multi-agent parallel execution
 * 
 * Problem: chat.qwen.ai serializes requests per (account, chat_id).
 * When multiple subagents hit the same account concurrently, the upstream
 * returns "chat is in progress" and all but one fail.
 * 
 * Solution: Promise-based mutex per accountId. A request acquires the lock
 * before touching the account and releases it in a finally block after the
 * stream completes. If the account is locked, callers can either:
 *   - try the next free account (auto-rotation)
 *   - wait with a timeout (queueing)
 *   - fail fast with 429 (no slot available)
 */

interface LockEntry {
  promise: Promise<void>;
  release: () => void;
  acquiredAt: number;
  owner: string; // requestId for observability
}

interface Waiter {
  resolve: (entry: LockEntry | null) => void;
  timer: NodeJS.Timeout;
  owner: string;
}

// Map of accountId -> currently-held lock
const activeLocks = new Map<string, LockEntry>();

// Map of accountId -> queue of waiters (FIFO)
const waiterQueues = new Map<string, Waiter[]>();

// Metrics
let totalAcquires = 0;
let totalContended = 0;
let totalTimeouts = 0;

/**
 * Acquire an exclusive lock on an account.
 * 
 * @param accountId - The account to lock
 * @param owner - Identifier of who is acquiring (for debug/metrics)
 * @param timeoutMs - Max ms to wait if the account is busy (0 = no wait, fail fast)
 * @returns LockEntry with a `release()` function, or null if lock could not be acquired
 */
export async function acquireAccountLock(
  accountId: string,
  owner: string = 'unknown',
  timeoutMs: number = 0
): Promise<LockEntry | null> {
  totalAcquires++;

  // Fast path: account is free
  if (!activeLocks.has(accountId)) {
    return createLock(accountId, owner);
  }

  // Account is busy
  totalContended++;

  if (timeoutMs <= 0) {
    // Fail fast - caller should try next account
    return null;
  }

  // Queue up and wait
  return await waitForLock(accountId, owner, timeoutMs);
}

/**
 * Create a new lock for a free account
 */
function createLock(accountId: string, owner: string): LockEntry {
  let releaseFn: (() => void) | null = null;
  
  const promise = new Promise<void>((resolve) => {
    releaseFn = () => {
      // Remove from active locks
      activeLocks.delete(accountId);
      
      // Wake up next waiter if any
      const queue = waiterQueues.get(accountId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        clearTimeout(next.timer);
        
        // Create new lock for the waiter
        const newLock = createLock(accountId, next.owner);
        activeLocks.set(accountId, newLock);
        next.resolve(newLock);
      } else {
        waiterQueues.delete(accountId);
      }
      
      resolve();
    };
  });

  const entry: LockEntry = {
    promise,
    release: releaseFn!,
    acquiredAt: Date.now(),
    owner,
  };

  activeLocks.set(accountId, entry);
  return entry;
}

/**
 * Wait for a lock to become available, with timeout
 */
function waitForLock(
  accountId: string,
  owner: string,
  timeoutMs: number
): Promise<LockEntry | null> {
  return new Promise<LockEntry | null>((resolve) => {
    const queue = waiterQueues.get(accountId) || [];
    
    const timer = setTimeout(() => {
      // Timeout: remove self from queue and return null
      const currentQueue = waiterQueues.get(accountId);
      if (currentQueue) {
        const idx = currentQueue.findIndex(w => w.owner === owner);
        if (idx !== -1) currentQueue.splice(idx, 1);
        if (currentQueue.length === 0) waiterQueues.delete(accountId);
      }
      totalTimeouts++;
      resolve(null);
    }, timeoutMs);

    const waiter: Waiter = { resolve, timer, owner };
    queue.push(waiter);
    waiterQueues.set(accountId, queue);
  });
}

/**
 * Check if an account is currently locked
 */
export function isAccountLocked(accountId: string): boolean {
  return activeLocks.has(accountId);
}

/**
 * Get lock info for observability
 */
export function getLockInfo(accountId: string): { locked: boolean; owner?: string; heldForMs?: number; waiters: number } {
  const lock = activeLocks.get(accountId);
  const queue = waiterQueues.get(accountId);
  
  if (!lock) {
    return { locked: false, waiters: queue?.length || 0 };
  }
  
  return {
    locked: true,
    owner: lock.owner,
    heldForMs: Date.now() - lock.acquiredAt,
    waiters: queue?.length || 0,
  };
}

/**
 * Get all locks for debugging/metrics endpoint
 */
export function getAllLocks(): Record<string, { owner: string; heldForMs: number; waiters: number }> {
  const result: Record<string, { owner: string; heldForMs: number; waiters: number }> = {};
  const now = Date.now();
  
  for (const [accountId, lock] of activeLocks.entries()) {
    result[accountId] = {
      owner: lock.owner,
      heldForMs: now - lock.acquiredAt,
      waiters: waiterQueues.get(accountId)?.length || 0,
    };
  }
  
  return result;
}

/**
 * Get aggregate lock metrics
 */
export function getLockMetrics(): {
  activeLocks: number;
  totalWaiters: number;
  totalAcquires: number;
  totalContended: number;
  totalTimeouts: number;
  contentionRate: number;
} {
  let totalWaiters = 0;
  for (const queue of waiterQueues.values()) {
    totalWaiters += queue.length;
  }
  
  return {
    activeLocks: activeLocks.size,
    totalWaiters,
    totalAcquires,
    totalContended,
    totalTimeouts,
    contentionRate: totalAcquires > 0 ? totalContended / totalAcquires : 0,
  };
}

/**
 * Emergency release: forcefully release a lock (use only for stuck locks)
 * Normally locks should always be released via the release() function in finally blocks.
 */
export function forceRelease(accountId: string): boolean {
  const lock = activeLocks.get(accountId);
  if (!lock) return false;
  
  console.warn(`[AccountLock] Force-releasing lock for ${accountId} (held by ${lock.owner} for ${Date.now() - lock.acquiredAt}ms)`);
  lock.release();
  return true;
}

/**
 * Detect and release stuck locks (older than maxAgeMs)
 * Call periodically from watchdog if desired.
 */
export function cleanupStuckLocks(maxAgeMs: number = 5 * 60 * 1000): number {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [accountId, lock] of activeLocks.entries()) {
    if (now - lock.acquiredAt > maxAgeMs) {
      console.warn(`[AccountLock] Cleaning up stuck lock for ${accountId} (held ${Math.round((now - lock.acquiredAt) / 1000)}s by ${lock.owner})`);
      lock.release();
      cleaned++;
    }
  }
  
  return cleaned;
}
