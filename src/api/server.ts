import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { serve } from '@hono/node-server'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { cache } from '../cache/memory-cache.js'
import { Watchdog, setShutdownCallback } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat/index.js';
import { warmPoolStatus, warmPoolRefill } from '../routes/warm-pool-status.js'
import { uploadFile } from '../routes/upload.js'
import { getStats as getSessionStats, cleanupOldSessions, deleteSession, closeSessionDb } from '../core/session-manager.js'
import { getAllLocks, getLockMetrics } from '../core/account-lock.js'
import { buildToolCallReinforcement } from '../routes/chat/helpers.js';
import type { Message } from '../utils/types.js';

// S2: Push lock metrics into the global metrics registry every collection cycle
// This makes contentionRate and activeLocks visible at /metrics (Prometheus format).
import { metrics as globalMetrics } from '../core/metrics.js'

/**
 * Build system prompt for /v1/system-prompt endpoint
 * Mirrors the logic in chatCompletions to ensure consistency
 */
function buildSystemPrompt(requestBody: any): string {
  let systemPrompt = '';
  
  // Base system prompt (from extractPrompt logic)
  if (requestBody.messages && Array.isArray(requestBody.messages)) {
    for (const msg of requestBody.messages) {
      if (msg.role === 'system') {
        let contentStr = '';
        if (Array.isArray(msg.content)) {
          const textParts: string[] = [];
          for (const p of msg.content as any[]) {
            if (p.type === 'text' && p.text) {
              textParts.push(p.text);
            }
          }
          contentStr = textParts.join('\n');
        } else if (typeof msg.content === 'object' && msg.content !== null) {
          contentStr = JSON.stringify(msg.content);
        } else {
          contentStr = msg.content || '';
        }
        systemPrompt += (contentStr) + '\n\n';
      }
    }
  }

  // Inject tools into system prompt (same logic as chatCompletions)
  const bodyAny = requestBody as any;
  if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
    const formattedTools = bodyAny.tools.map((t: any) => {
      if (t.type === 'function') {
        return {
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters
        };
      }
      return t;
    });
    const toolsJson = JSON.stringify(formattedTools, null, 2);
    
    const forcedTool = bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function
      ? bodyAny.tool_choice.function.name
      : undefined;
    
    systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n` + buildToolCallReinforcement(true, forcedTool);
  }

  return systemPrompt;
}

function pushLockMetrics() {
  try {
    const m = getLockMetrics();
    globalMetrics.gauge('locks.active', m.activeLocks);
    globalMetrics.gauge('locks.waiters', m.totalWaiters);
    globalMetrics.gauge('locks.acquires_total', m.totalAcquires);
    globalMetrics.gauge('locks.contended_total', m.totalContended);
    globalMetrics.gauge('locks.timeouts_total', m.totalTimeouts);
    // contentionRate * 1000 to preserve 3 decimals as integer (Prometheus best practice)
    globalMetrics.gauge('locks.contention_rate_per_mille', Math.round(m.contentionRate * 1000));
  } catch {}
}

const app = new Hono()

let watchdog: Watchdog
let server: any

// Compressão HTTP (gzip) para respostas > 1KB
app.use('*', compress({
  encoding: 'gzip',
  threshold: 1024,
}))

app.use('*', async (c, next) => {
  console.log('[Debug] Request START:', c.req.method, c.req.path)
  metrics.increment('requests.total')
  const start = Date.now()
  await next()
  console.log('[Debug] Request END:', c.req.method, c.req.path, '->', c.res?.status)
  const duration = Date.now() - start
  metrics.histogram('latency.request', duration)
  c.header('X-Response-Time', `${duration}ms`)
})

app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY || config.apiKey
  console.log('[Auth] Expected API_KEY:', apiKey ? `${apiKey.slice(0, 8)}...` : 'empty')
  if (apiKey) {
    const auth = c.req.header('Authorization')
    console.log('[Auth] Received Authorization header:', auth ? `${auth.slice(0, 20)}...` : 'none')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const token = auth.slice(7)
    console.log('[Auth] Comparing token:', token ? `${token.slice(0, 8)}...` : 'empty', 'vs expected:', apiKey.slice(0, 8) + '...')
    if (token !== apiKey) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  }
  await next()
})

// NEW: /v1/system-prompt endpoint for subagents to fetch correct system prompt with tool format enforcement
app.post('/v1/system-prompt', async (c) => {
  try {
    const body = await c.req.json();
    const systemPrompt = buildSystemPrompt(body);
    
    // Also return the tools array for convenience
    const tools = body.tools && Array.isArray(body.tools) 
      ? body.tools.map((t: any) => t.type === 'function' ? {
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters
        } : t)
      : [];
    
    return c.json({
      systemPrompt,
      tools,
      hasTools: tools.length > 0,
      toolChoice: body.tool_choice || null
    });
  } catch (err: any) {
    console.error('[SystemPrompt] Error:', err.message);
    return c.json({ error: err.message }, 400);
  }
})

app.route('', modelsApp)
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)
app.post('/v1/upload', uploadFile)
app.get('/v1/warm-pool/status', warmPoolStatus)
app.post('/v1/warm-pool/refill', warmPoolRefill)

app.get('/health', async (c) => {
  const status = await watchdog?.getStatus()
  const sessionStats = getSessionStats()
  return c.json({
    status: status?.overall || 'unknown',
    timestamp: Date.now(),
    metrics: {
      cache: await cache?.getStats(),
    },
    sessions: sessionStats,
  })
})

app.get('/sessions/stats', (c) => {
  return c.json(getSessionStats())
})

app.post('/sessions/cleanup', (c) => {
  const maxAgeDays = parseInt(c.req.query('maxAgeDays') || '7')
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
  const deleted = cleanupOldSessions(maxAgeMs)
  return c.json({ deleted, maxAgeDays })
})

app.delete('/sessions/:id', (c) => {
  const id = c.req.param('id')
  deleteSession(id)
  return c.json({ success: true, id })
})

app.get('/metrics', (c) => {
  return c.text(metrics.formatPrometheus(), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' }
  })
})

// S2: Account lock observability — shows which accounts are currently
// locked by active requests, who holds them, and queue depth.
// Useful for debugging multi-agent parallel execution.
app.get('/v1/accounts/locks', (c) => {
  return c.json({
    locks: getAllLocks(),
    metrics: getLockMetrics(),
  });
})

app.onError((err, c) => {
  metrics.increment('requests.errors')
  console.error('API Error:', err)
  return c.json({ error: err.message }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export async function startServer(): Promise<void> {
  await cache.connect()

  const cleanedSessions = cleanupOldSessions(7 * 24 * 60 * 60 * 1000)
  if (cleanedSessions > 0) {
    console.log(`[Server] Cleaned ${cleanedSessions} old sessions`)
  }

  const { loadAccounts } = await import('../core/accounts.js')
  const accounts = loadAccounts()

  const { initPlaywright, initPlaywrightForAccount, getQwenHeaders } = await import('../services/playwright.js')
  
  // Auto-reauth: start periodic checker
  const { startAutoReauthChecker, stopAutoReauthChecker } = await import('../services/qwen.js')
  startAutoReauthChecker()

  await initPlaywright(config.browser.headless)
  
  if (accounts.length > 0) {
    console.log(`[Server] ${accounts.length} configured account(s) - lazy initialization enabled`)
    // Pre-warming disabled to avoid OOM with multiple browser contexts
    // Accounts will be initialized on first use via getBasicHeaders
  }

  watchdog = new Watchdog()
  watchdog.start()

  metrics.startCollection()

  // S2: Periodically export lock state to Prometheus metrics
  const lockMetricsInterval = setInterval(pushLockMetrics, 5000);
  pushLockMetrics();  // initial push

  server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  }, (info) => {
    console.log(`Server listening on http://${info.address}:${info.port}`)
  })

  const shutdown = async (signal?: string) => {
    console.log(`Received ${signal || 'WATCHDOG_RESTART'}, shutting down gracefully...`)
    watchdog.stop()
    metrics.stopCollection()
    clearInterval(lockMetricsInterval)
    stopAutoReauthChecker()
    await cache.close()
    closeSessionDb()
    const { closePlaywright } = await import('../services/playwright.js')
    await closePlaywright()
    const { closeDatabase } = await import('../core/database.js')
    closeDatabase()
    server?.close()
    process.exit(0)
  }

  // Register shutdown callback for watchdog auto-restart
  setShutdownCallback(shutdown)

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }