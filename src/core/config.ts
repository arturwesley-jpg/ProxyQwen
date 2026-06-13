import { z } from 'zod'

const envSchema = z.object({
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),
  HEADLESS: z.string().default('true'),
  BROWSER: z.enum(['chromium', 'firefox', 'webkit', 'chrome', 'edge']).default('chromium'),
  USER_DATA_DIR: z.string().default('./qwen_profiles'),
  USER_AGENT: z.string().default('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
  LOG_CONSOLE: z.string().default('false'),
  NAVIGATION_TIMEOUT: z.string().default('30000'),
  PAGE_TIMEOUT: z.string().default('15000'),
  HTTP_TIMEOUT: z.string().default('10000'),
  CHAT_TIMEOUT: z.string().default('120000'),
  CACHE_TTL: z.string().default('3600'),
  RESPONSE_TTL: z.string().default('1800'),
  METRICS_INTERVAL: z.string().default('10000'),
  WATCHDOG_INTERVAL: z.string().default('30000'),
  WATCHDOG_FAILURES: z.string().default('5'),
  RAM_WARNING: z.string().default('85'),
  RAM_CRITICAL: z.string().default('95'),
  WS_WARNING: z.string().default('50'),
  WS_CRITICAL: z.string().default('100'),
  QWEN_BASE_URL: z.string().default('https://chat.qwen.ai'),
  QWEN_HTTP_ENDPOINT: z.string().default('https://api.qwen.ai/v1/chat'),
  QWEN_API_KEY: z.string().default(''),
  API_KEY: z.string().default(''),
  // Rate Limiter
  RATE_LIMIT_ACCOUNT_CAPACITY: z.string().default('10'),
  RATE_LIMIT_ACCOUNT_REFILL: z.string().default('2'),
  RATE_LIMIT_TENANT_CAPACITY: z.string().default('100'),
  RATE_LIMIT_TENANT_REFILL: z.string().default('20'),
  RATE_LIMIT_GLOBAL_CAPACITY: z.string().default('500'),
  RATE_LIMIT_GLOBAL_REFILL: z.string().default('100'),
  // Circuit Breaker
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.string().default('5'),
  CIRCUIT_BREAKER_RESET_TIMEOUT: z.string().default('30000'),
  CIRCUIT_BREAKER_SUCCESS_THRESHOLD: z.string().default('2'),
  CIRCUIT_BREAKER_REQUEST_TIMEOUT: z.string().default('30000'),
  CIRCUIT_BREAKER_MIN_REQUESTS: z.string().default('10'),
  CIRCUIT_BREAKER_FAILURE_RATE: z.string().default('50'),
  CIRCUIT_BREAKER_WINDOW_MS: z.string().default('60000'),
})

const env = envSchema.parse(process.env)

export const config = {
  server: {
    port: parseInt(env.PORT),
    host: env.HOST,
  },
  browser: {
    headless: env.HEADLESS !== 'false',
    type: env.BROWSER,
    userDataDir: env.USER_DATA_DIR,
    userAgent: env.USER_AGENT,
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-features=IsolateOrigins,site-per-process',
      // Aggressive memory management
      '--single-process',
      '--no-sandbox',
      '--js-flags=--max-old-space-size=512',
      '--render-process-limit=2',
      '--disable-site-isolation-trials',
      '--disable-web-security',
      '--disable-features=TranslateUI,BlinkGenPropertyTrees',
      '--memory-pressure-off',
    ],
    launchTimeout: 30000,
    healthCheckInterval: 30000,
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    logConsole: env.LOG_CONSOLE === 'true',
  },
  timeouts: {
    navigation: parseInt(env.NAVIGATION_TIMEOUT),
    page: parseInt(env.PAGE_TIMEOUT),
    http: parseInt(env.HTTP_TIMEOUT),
    chat: parseInt(env.CHAT_TIMEOUT),
  },
  cache: {
    defaultTTL: parseInt(env.CACHE_TTL),
    responseTTL: parseInt(env.RESPONSE_TTL),
  },
  metrics: {
    interval: parseInt(env.METRICS_INTERVAL),
  },
  watchdog: {
    checkInterval: parseInt(env.WATCHDOG_INTERVAL),
    consecutiveFailuresThreshold: parseInt(env.WATCHDOG_FAILURES),
    ram: {
      warningThreshold: parseInt(env.RAM_WARNING),
      criticalThreshold: parseInt(env.RAM_CRITICAL),
    },
    streams: {
      warningThreshold: parseInt(env.WS_WARNING),
      criticalThreshold: parseInt(env.WS_CRITICAL),
    },
    // Auto-restart on critical memory - handled by PM2 max_memory_restart instead
    autoRestartOnCritical: false,
    restartDelayMs: 30000,
  },
  rateLimiter: {
    account: {
      capacity: parseInt(env.RATE_LIMIT_ACCOUNT_CAPACITY),
      refillRate: parseFloat(env.RATE_LIMIT_ACCOUNT_REFILL),
    },
    tenant: {
      capacity: parseInt(env.RATE_LIMIT_TENANT_CAPACITY),
      refillRate: parseFloat(env.RATE_LIMIT_TENANT_REFILL),
    },
    global: {
      capacity: parseInt(env.RATE_LIMIT_GLOBAL_CAPACITY),
      refillRate: parseFloat(env.RATE_LIMIT_GLOBAL_REFILL),
    },
  },
  circuitBreaker: {
    failureThreshold: parseInt(env.CIRCUIT_BREAKER_FAILURE_THRESHOLD),
    resetTimeoutMs: parseInt(env.CIRCUIT_BREAKER_RESET_TIMEOUT),
    successThreshold: parseInt(env.CIRCUIT_BREAKER_SUCCESS_THRESHOLD),
    requestTimeoutMs: parseInt(env.CIRCUIT_BREAKER_REQUEST_TIMEOUT),
    minimumRequests: parseInt(env.CIRCUIT_BREAKER_MIN_REQUESTS),
    failureRateThreshold: parseInt(env.CIRCUIT_BREAKER_FAILURE_RATE),
    windowMs: parseInt(env.CIRCUIT_BREAKER_WINDOW_MS),
  },
  apiKey: env.API_KEY,
  qwen: {
    baseUrl: env.QWEN_BASE_URL,
    httpEndpoint: env.QWEN_HTTP_ENDPOINT,
    apiKey: env.QWEN_API_KEY,
  },
}

export type Config = typeof config
