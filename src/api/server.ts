import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { serve } from '@hono/node-server'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { cache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'
import { warmPoolStatus, warmPoolRefill } from '../routes/warm-pool-status.js'
import { uploadFile } from '../routes/upload.js'
import { getStats as getSessionStats, cleanupOldSessions, deleteSession, closeSessionDb } from '../core/session-manager.js'
import { getAllLocks, getLockMetrics } from '../core/account-lock.js'

// S2: Push lock metrics into the global metrics registry every collection cycle
// This makes contentionRate and activeLocks visible at /metrics (Prometheus format).
import { metrics as globalMetrics } from '../core/metrics.js'
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
  metrics.increment('requests.total')
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  metrics.histogram('latency.request', duration)
  c.header('X-Response-Time', `${duration}ms`)
})

app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY || config.apiKey
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const token = auth.slice(7)
    if (token !== apiKey) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  }
  await next()
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
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
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
  
  await initPlaywright(config.browser.headless)
  
  if (accounts.length > 0) {
    console.log(`[Server] Pre-warming ${accounts.length} configured account(s) in parallel...`)
    await Promise.all(
      accounts.map(account =>
        initPlaywrightForAccount(account, config.browser.headless).catch((err: any) => {
          console.error(`[Server] Failed to initialize account ${account.email}:`, err.message)
        })
      )
    )
    console.log('[Server] Pre-fetching headers for all accounts in background...')
    const { warmAllPools } = await import('../services/qwen.js')
    warmAllPools(accounts.map(a => a.id)).catch(() => {})
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

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`)
    watchdog.stop()
    metrics.stopCollection()
    clearInterval(lockMetricsInterval)
    await cache.close()
    closeSessionDb()
    const { closePlaywright } = await import('../services/playwright.js')
    await closePlaywright()
    const { closeDatabase } = await import('../core/database.js')
    closeDatabase()
    server?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
