/*
 * File: opentelemetry.ts
 * Project: qwenproxy
 * OpenTelemetry integration for distributed tracing and structured logging
 */

import crypto from 'crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'ok' | 'error';
  tags: Record<string, string | number | boolean>;
  logs: Array<{ timestamp: number; message: string; fields?: Record<string, any> }>;
  error?: Error;
}

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  traceId?: string;
  spanId?: string;
  fields?: Record<string, any>;
}

export interface OpenTelemetryConfig {
  enabled: boolean;
  serviceName: string;
  samplingRate: number; // 0.0 to 1.0
  exporter: 'console' | 'jaeger' | 'otlp';
  jaegerEndpoint?: string;
  otlpEndpoint?: string;
  maxSpans: number; // Buffer size before flush
  flushIntervalMs: number;
}

const DEFAULT_CONFIG: OpenTelemetryConfig = {
  enabled: false,
  serviceName: 'qwenproxy',
  samplingRate: 0.1, // 10% sampling
  exporter: 'console',
  maxSpans: 100,
  flushIntervalMs: 5000,
};

let config: OpenTelemetryConfig = { ...DEFAULT_CONFIG };
let currentTraceContext: TraceContext | null = null;
const spanBuffer: Span[] = [];
const logBuffer: LogEntry[] = [];
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Generate random trace ID (32 hex chars)
 */
function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate random span ID (16 hex chars)
 */
function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Create new trace context
 */
export function startTrace(operationName: string, parentContext?: TraceContext): TraceContext {
  const sampled = Math.random() < config.samplingRate;
  
  const context: TraceContext = {
    traceId: parentContext?.traceId || generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId: parentContext?.spanId,
    sampled,
  };

  if (sampled) {
    currentTraceContext = context;
    
    const span: Span = {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      operationName,
      startTime: Date.now(),
      status: 'ok',
      tags: {},
      logs: [],
    };
    
    spanBuffer.push(span);
    
    if (config.exporter === 'console') {
      console.log(
        `[TRACE] Started: ${operationName} | trace=${context.traceId.slice(0, 8)} span=${context.spanId.slice(0, 8)}`
      );
    }
  }

  return context;
}

/**
 * End current span
 */
export function endTrace(context: TraceContext, error?: Error): void {
  if (!context.sampled) return;

  const span = spanBuffer.find(
    s => s.spanId === context.spanId && !s.endTime
  );

  if (span) {
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = error ? 'error' : 'ok';
    if (error) {
      span.error = error;
      span.tags['error.message'] = error.message;
      span.tags['error.stack'] = error.stack || '';
    }

    if (config.exporter === 'console') {
      const status = error ? 'ERROR' : 'OK';
      console.log(
        `[TRACE] Ended: ${span.operationName} | ${status} | ${span.duration}ms | ` +
        `trace=${context.traceId.slice(0, 8)} span=${context.spanId.slice(0, 8)}`
      );
    }
  }

  // Reset current context if this was the root span
  if (!context.parentSpanId) {
    currentTraceContext = null;
  }

  // Flush if buffer is full
  if (spanBuffer.length >= config.maxSpans) {
    flush();
  }
}

/**
 * Add tag to current span
 */
export function addTag(key: string, value: string | number | boolean, context?: TraceContext): void {
  const ctx = context || currentTraceContext;
  if (!ctx || !ctx.sampled) return;

  const span = spanBuffer.find(s => s.spanId === ctx.spanId && !s.endTime);
  if (span) {
    span.tags[key] = value;
  }
}

/**
 * Add log to current span
 */
export function addSpanLog(
  message: string,
  fields?: Record<string, any>,
  context?: TraceContext
): void {
  const ctx = context || currentTraceContext;
  if (!ctx || !ctx.sampled) return;

  const span = spanBuffer.find(s => s.spanId === ctx.spanId && !s.endTime);
  if (span) {
    span.logs.push({
      timestamp: Date.now(),
      message,
      fields,
    });
  }
}

/**
 * Structured logging with trace context
 */
export function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, any>
): void {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level,
    message,
    traceId: currentTraceContext?.traceId,
    spanId: currentTraceContext?.spanId,
    fields,
  };

  logBuffer.push(entry);

  if (config.exporter === 'console') {
    const traceInfo = currentTraceContext
      ? ` [trace=${currentTraceContext.traceId.slice(0, 8)}]`
      : '';
    const fieldsStr = fields ? ` ${JSON.stringify(fields)}` : '';
    console.log(
      `[${new Date(entry.timestamp).toISOString()}] ${level.toUpperCase()}${traceInfo}: ${message}${fieldsStr}`
    );
  }

  // Flush logs if buffer is large
  if (logBuffer.length >= config.maxSpans * 2) {
    flushLogs();
  }
}

/**
 * Flush spans to exporter
 */
function flush(): void {
  if (spanBuffer.length === 0) return;

  const spansToExport = [...spanBuffer];
  spanBuffer.length = 0;

  if (config.exporter === 'console') {
    // Already logged in real-time, just clear buffer
    return;
  }

  if (config.exporter === 'jaeger' && config.jaegerEndpoint) {
    // TODO: Implement Jaeger HTTP exporter
    // POST to {jaegerEndpoint}/api/traces with Jaeger Thrift format
    console.warn('[OpenTelemetry] Jaeger exporter not yet implemented');
  }

  if (config.exporter === 'otlp' && config.otlpEndpoint) {
    // TODO: Implement OTLP HTTP exporter
    // POST to {otlpEndpoint}/v1/traces with OTLP JSON format
    console.warn('[OpenTelemetry] OTLP exporter not yet implemented');
  }
}

/**
 * Flush logs to exporter
 */
function flushLogs(): void {
  if (logBuffer.length === 0) return;

  const logsToExport = [...logBuffer];
  logBuffer.length = 0;

  if (config.exporter === 'console') {
    // Already logged in real-time
    return;
  }

  // TODO: Implement log exporters (Loki, Elasticsearch, etc.)
}

/**
 * Start periodic flush timer
 */
export function startFlushTimer(): void {
  if (flushTimer) return;

  flushTimer = setInterval(() => {
    flush();
    flushLogs();
  }, config.flushIntervalMs);
}

/**
 * Stop flush timer and flush remaining data
 */
export function stopFlushTimer(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flush();
  flushLogs();
}

/**
 * Get current trace context
 */
export function getCurrentTraceContext(): TraceContext | null {
  return currentTraceContext;
}

/**
 * Update OpenTelemetry config
 */
export function setOpenTelemetryConfig(partial: Partial<OpenTelemetryConfig>): void {
  config = { ...config, ...partial };
  console.log('[OpenTelemetry] Config updated:', config);
}

/**
 * Get current config
 */
export function getOpenTelemetryConfig(): OpenTelemetryConfig {
  return { ...config };
}

/**
 * Get telemetry statistics
 */
export function getTelemetryStats(): {
  spansBuffered: number;
  logsBuffered: number;
  activeTraces: number;
  samplingRate: number;
} {
  const activeTraces = new Set(spanBuffer.filter(s => !s.endTime).map(s => s.traceId)).size;
  
  return {
    spansBuffered: spanBuffer.length,
    logsBuffered: logBuffer.length,
    activeTraces,
    samplingRate: config.samplingRate,
  };
}

/**
 * Convenience wrapper: execute function with automatic tracing
 */
export async function withTrace<T>(
  operationName: string,
  fn: (context: TraceContext) => Promise<T>,
  parentContext?: TraceContext
): Promise<T> {
  const context = startTrace(operationName, parentContext);
  
  try {
    const result = await fn(context);
    endTrace(context);
    return result;
  } catch (error) {
    endTrace(context, error as Error);
    throw error;
  }
}

// Auto-start flush timer if enabled
if (config.enabled) {
  startFlushTimer();
}
