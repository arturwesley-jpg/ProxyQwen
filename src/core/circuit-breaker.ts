/*
 * File: circuit-breaker.ts
 * Project: qwenproxy
 * Circuit breaker pattern for upstream failure handling
 *
 * Implements the circuit breaker pattern with three states:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failing fast, requests blocked immediately
 * - HALF_OPEN: Testing if upstream recovered, limited requests allowed
 *
 * Features:
 * - Per-account/endpoint circuit breakers
 * - Configurable failure thresholds and timeouts
 * - Automatic transition between states
 * - Metrics integration for observability
 * - Manual reset capability
 */

import { EventEmitter } from 'events';
import { metrics } from './metrics.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms before transitioning from OPEN to HALF_OPEN */
  resetTimeoutMs: number;
  /** Number of successful requests in HALF_OPEN before closing */
  successThreshold: number;
  /** Request timeout in ms (requests exceeding this count as failures) */
  requestTimeoutMs?: number;
  /** Minimum requests before evaluating failure rate */
  minimumRequests?: number;
  /** Failure rate percentage (0-100) to trigger OPEN state */
  failureRateThreshold?: number;
  /** Time window in ms for failure rate calculation */
  windowMs?: number;
}

export interface CircuitBreakerResult<T = any> {
  success: boolean;
  result?: T;
  error?: Error;
  state: CircuitState;
  retryAfterMs?: number;
}

export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  totalRequests: number;
  failureRate: number;
  lastFailure?: number;
  lastSuccess?: number;
  nextAttempt?: number;
  rejectedRequests: number;
}

interface RequestRecord {
  success: boolean;
  timestamp: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,      // 30 seconds
  successThreshold: 2,        // 2 successes to close
  requestTimeoutMs: 30000,
  minimumRequests: 10,
  failureRateThreshold: 50,   // 50% failure rate
  windowMs: 60000,            // 1 minute sliding window
};

/**
 * Circuit breaker for protecting upstream services
 */
export class CircuitBreaker extends EventEmitter {
  private name: string;
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private totalRequests = 0;
  private requestHistory: RequestRecord[] = [];
  private rejectedRequests = 0;
  private lastFailure?: number;
  private lastSuccess?: number;
  private nextAttempt?: number;
  private halfOpenSuccesses = 0;
  private stateChangeCallbacks = new Set<(state: CircuitState, name: string) => void>();

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute an operation with circuit breaker protection
   */
  async execute<T>(operation: () => Promise<T>): Promise<CircuitBreakerResult<T>> {
    // Check if circuit allows request
    const stateCheck = this.checkState();
    if (!stateCheck.allowed) {
      this.rejectedRequests++;
      metrics.increment('circuit_breaker.rejected', 1, { name: this.name, state: this.state });
      this.emit('rejected', { name: this.name, state: this.state, retryAfterMs: stateCheck.retryAfterMs });
      return {
        success: false,
        error: new Error(`Circuit breaker ${this.name} is ${this.state}`),
        state: this.state,
        retryAfterMs: stateCheck.retryAfterMs,
      };
    }

    this.totalRequests++;
    metrics.increment('circuit_breaker.requests', 1, { name: this.name, state: this.state });

    const startTime = Date.now();
    let result: T;
    let error: Error | undefined;

    try {
      // Execute with timeout if configured
      if (this.config.requestTimeoutMs) {
        result = await this.withTimeout(operation(), this.config.requestTimeoutMs);
      } else {
        result = await operation();
      }

      this.onSuccess();
      return { success: true, result, state: this.state };
    } catch (err) {
      error = err as Error;
      this.onFailure();
      return { success: false, error, state: this.state };
    } finally {
      const latency = Date.now() - startTime;
      metrics.histogram('circuit_breaker.latency', latency, { name: this.name, state: this.state });
    }
  }

  /**
   * Execute with timeout
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  /**
   * Check if request should be allowed based on current state
   */
  private checkState(): { allowed: boolean; retryAfterMs?: number } {
    this.cleanupHistory();

    switch (this.state) {
      case 'CLOSED':
        return { allowed: true };

      case 'OPEN':
        const now = Date.now();
        if (this.nextAttempt && now >= this.nextAttempt) {
          // Transition to HALF_OPEN
          this.transitionToHalfOpen();
          return { allowed: true };
        }
        return {
          allowed: false,
          retryAfterMs: this.nextAttempt ? this.nextAttempt - now : this.config.resetTimeoutMs,
        };

      case 'HALF_OPEN':
        // Allow limited requests in HALF_OPEN
        return { allowed: true };
    }
  }

  /**
   * Handle successful request
   */
  private onSuccess(): void {
    this.recordRequest(true);
    this.successes++;
    this.lastSuccess = Date.now();
    metrics.increment('circuit_breaker.success', 1, { name: this.name, state: this.state });

    if (this.state === 'HALF_OPEN') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.successThreshold) {
        this.transitionToClosed();
      }
    }

    this.emit('success', { name: this.name, state: this.state });
  }

  /**
   * Handle failed request
   */
  private onFailure(): void {
    this.recordRequest(false);
    this.failures++;
    this.lastFailure = Date.now();
    metrics.increment('circuit_breaker.failure', 1, { name: this.name, state: this.state });

    if (this.state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN reopens the circuit
      this.transitionToOpen();
    } else if (this.state === 'CLOSED') {
      // Check absolute failure threshold
      if (this.failures >= this.config.failureThreshold) {
        this.transitionToOpen();
      } else {
        // Also evaluate failure rate as secondary trigger
        this.evaluateFailureRate();
      }
    }

    this.emit('failure', { name: this.name, state: this.state, failureCount: this.failures });
  }

  /**
   * Record request in sliding window history
   */
  private recordRequest(success: boolean): void {
    const now = Date.now();
    this.requestHistory.push({ success, timestamp: now });
    this.cleanupHistory();
  }

  /**
   * Remove old entries from history
   */
  private cleanupHistory(): void {
    const cutoff = Date.now() - (this.config.windowMs || 60000);
    this.requestHistory = this.requestHistory.filter(r => r.timestamp > cutoff);
  }

  /**
   * Evaluate if failure rate exceeds threshold
   */
  private evaluateFailureRate(): void {
    const recentRequests = this.requestHistory.length;
    if (recentRequests < (this.config.minimumRequests || 10)) {
      return; // Not enough data
    }

    const failures = this.requestHistory.filter(r => !r.success).length;
    const failureRate = (failures / recentRequests) * 100;

    if (failureRate >= (this.config.failureRateThreshold || 50)) {
      this.transitionToOpen();
    }
  }

  /**
   * Transition to OPEN state
   */
  private transitionToOpen(): void {
    if (this.state === 'OPEN') return;

    this.state = 'OPEN';
    this.nextAttempt = Date.now() + this.config.resetTimeoutMs;
    this.halfOpenSuccesses = 0;
    metrics.gauge('circuit_breaker.state', 2, { name: this.name }); // 2 = OPEN
    console.warn(`[CircuitBreaker] ${this.name} OPENED - failing fast for ${this.config.resetTimeoutMs}ms`);
    this.emitStateChange();
  }

  /**
   * Transition to HALF_OPEN state
   */
  private transitionToHalfOpen(): void {
    this.state = 'HALF_OPEN';
    this.halfOpenSuccesses = 0;
    this.nextAttempt = undefined;
    metrics.gauge('circuit_breaker.state', 1, { name: this.name }); // 1 = HALF_OPEN
    console.log(`[CircuitBreaker] ${this.name} HALF_OPEN - testing upstream`);
    this.emitStateChange();
  }

  /**
   * Transition to CLOSED state
   */
  private transitionToClosed(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.halfOpenSuccesses = 0;
    this.nextAttempt = undefined;
    this.requestHistory = [];
    metrics.gauge('circuit_breaker.state', 0, { name: this.name }); // 0 = CLOSED
    console.log(`[CircuitBreaker] ${this.name} CLOSED - normal operation restored`);
    this.emitStateChange();
  }

  /**
   * Emit state change event and call callbacks
   */
  private emitStateChange(): void {
    this.emit('stateChange', { name: this.name, state: this.state });
    for (const cb of this.stateChangeCallbacks) {
      try {
        cb(this.state, this.name);
      } catch (err) {
        console.error(`[CircuitBreaker] State change callback error:`, err);
      }
    }
  }

  /**
   * Get current stats
   */
  getStats(): CircuitBreakerStats {
    this.cleanupHistory();
    const recentRequests = this.requestHistory.length;
    const failures = this.requestHistory.filter(r => !r.success).length;
    const failureRate = recentRequests > 0 ? (failures / recentRequests) * 100 : 0;

    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalRequests: this.totalRequests,
      failureRate: Math.round(failureRate * 100) / 100,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      nextAttempt: this.nextAttempt,
      rejectedRequests: this.rejectedRequests,
    };
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    this.checkState(); // This may trigger transitions
    return this.state;
  }

  /**
   * Check if circuit is closed (normal operation)
   */
  isClosed(): boolean {
    return this.getState() === 'CLOSED';
  }

  /**
   * Check if circuit is open (failing fast)
   */
  isOpen(): boolean {
    return this.getState() === 'OPEN';
  }

  /**
   * Check if circuit is half-open (testing)
   */
  isHalfOpen(): boolean {
    return this.getState() === 'HALF_OPEN';
  }

  /**
   * Manually reset the circuit breaker to CLOSED state
   */
  reset(): void {
    this.transitionToClosed();
    this.totalRequests = 0;
    this.rejectedRequests = 0;
    this.emit('reset', { name: this.name });
  }

  /**
   * Manually force open the circuit breaker
   */
  forceOpen(): void {
    this.transitionToOpen();
    this.emit('forceOpen', { name: this.name });
  }

  /**
   * Register a state change callback
   */
  onStateChange(callback: (state: CircuitState, name: string) => void): () => void {
    this.stateChangeCallbacks.add(callback);
    return () => this.stateChangeCallbacks.delete(callback);
  }

  /**
   * Get time until next attempt (if OPEN)
   */
  getRetryAfterMs(): number | undefined {
    if (this.state === 'OPEN' && this.nextAttempt) {
      return Math.max(0, this.nextAttempt - Date.now());
    }
    return undefined;
  }
}

/**
 * Circuit breaker registry for managing multiple breakers
 */
export class CircuitBreakerRegistry extends EventEmitter {
  private breakers = new Map<string, CircuitBreaker>();
  private defaultConfig: Partial<CircuitBreakerConfig>;

  constructor(defaultConfig: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.defaultConfig = defaultConfig;
  }

  /**
   * Get or create a circuit breaker
   */
  getBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, { ...this.defaultConfig, ...config });
      breaker.on('stateChange', (data) => this.emit('stateChange', data));
      breaker.on('rejected', (data) => this.emit('rejected', data));
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /**
   * Check if a breaker exists
   */
  hasBreaker(name: string): boolean {
    return this.breakers.has(name);
  }

  /**
   * Remove a breaker
   */
  removeBreaker(name: string): boolean {
    return this.breakers.delete(name);
  }

  /**
   * Execute operation with named circuit breaker
   */
  async execute<T>(name: string, operation: () => Promise<T>, config?: Partial<CircuitBreakerConfig>): Promise<CircuitBreakerResult<T>> {
    const breaker = this.getBreaker(name, config);
    return breaker.execute(operation);
  }

  /**
   * Get stats for a specific breaker
   */
  getStats(name: string): CircuitBreakerStats | null {
    const breaker = this.breakers.get(name);
    return breaker?.getStats() ?? null;
  }

  /**
   * Get all breaker stats
   */
  getAllStats(): CircuitBreakerStats[] {
    const stats: CircuitBreakerStats[] = [];
    for (const [name, breaker] of this.breakers.entries()) {
      stats.push(breaker.getStats());
    }
    return stats;
  }

  /**
   * Get breakers by state
   */
  getByState(state: CircuitState): CircuitBreaker[] {
    const result: CircuitBreaker[] = [];
    for (const breaker of this.breakers.values()) {
      if (breaker.getState() === state) {
        result.push(breaker);
      }
    }
    return result;
  }

  /**
   * Reset all breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Force open all breakers
   */
  forceOpenAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.forceOpen();
    }
  }

  /**
   * Shutdown registry
   */
  shutdown(): void {
    this.breakers.clear();
  }
}

/**
 * Create circuit breaker registry from environment
 */
export function createCircuitBreakerRegistryFromEnv(): CircuitBreakerRegistry {
  return new CircuitBreakerRegistry({
    failureThreshold: parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD || '5'),
    resetTimeoutMs: parseInt(process.env.CIRCUIT_BREAKER_RESET_TIMEOUT || '30000'),
    successThreshold: parseInt(process.env.CIRCUIT_BREAKER_SUCCESS_THRESHOLD || '2'),
    requestTimeoutMs: parseInt(process.env.CIRCUIT_BREAKER_REQUEST_TIMEOUT || '30000'),
    minimumRequests: parseInt(process.env.CIRCUIT_BREAKER_MIN_REQUESTS || '10'),
    failureRateThreshold: parseInt(process.env.CIRCUIT_BREAKER_FAILURE_RATE || '50'),
    windowMs: parseInt(process.env.CIRCUIT_BREAKER_WINDOW_MS || '60000'),
  });
}

// Singleton instance
export const circuitBreakerRegistry = createCircuitBreakerRegistryFromEnv();

/**
 * Predefined breaker names for common use cases
 */
export const CIRCUIT_BREAKERS = {
  QWEN_API: 'qwen-api',
  QWEN_CHAT: 'qwen-chat',
  LOGIN: 'login',
  HEADER_REFRESH: 'header-refresh',
  PLAYWRIGHT: 'playwright',
} as const;