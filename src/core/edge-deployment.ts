/*
 * File: edge-deployment.ts
 * Project: qwenproxy
 * Edge deployment configuration and utilities for Cloudflare Workers
 */

export interface EdgeConfig {
  enabled: boolean;
  provider: 'cloudflare' | 'deno' | 'none';
  regions: string[];
  cacheStrategy: 'aggressive' | 'conservative' | 'none';
  kvNamespace?: string;
  durableObjects?: boolean;
}

const DEFAULT_CONFIG: EdgeConfig = {
  enabled: false,
  provider: 'cloudflare',
  regions: ['auto'], // Cloudflare auto-selects
  cacheStrategy: 'conservative',
  kvNamespace: 'QWENPROXY_CACHE',
  durableObjects: false,
};

let config: EdgeConfig = { ...DEFAULT_CONFIG };

/**
 * Generate Cloudflare Worker script (wrangler.toml + worker.js)
 */
export function generateCloudflareWorker(): {
  wranglerToml: string;
  workerJs: string;
} {
  const wranglerToml = `
name = "qwenproxy-edge"
main = "worker.js"
compatibility_date = "2026-01-01"

[vars]
API_VERSION = "v1"
CACHE_TTL = "3600"

[[kv_namespaces]]
binding = "CACHE"
id = "${config.kvNamespace || 'your-kv-namespace-id'}"

[durable_objects]
bindings = [
  { name = "SESSIONS", class_name = "SessionManager" }
]

[[migrations]]
tag = "v1"
new_classes = ["SessionManager"]

[triggers]
crons = ["*/5 * * * *"]  # Cleanup every 5 minutes
`;

  const workerJs = `
// QwenProxy Edge Worker for Cloudflare
// This is a simplified edge proxy that forwards to origin

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'healthy',
        region: request.cf?.colo || 'unknown',
        timestamp: Date.now()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Cache lookup for GET requests
    if (request.method === 'GET') {
      const cacheKey = url.pathname + url.search;
      const cached = await env.CACHE.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
            'X-Region': request.cf?.colo || 'unknown'
          }
        });
      }
    }

    // Forward to origin
    const originUrl = env.ORIGIN_URL || 'http://localhost:3000';
    const originRequest = new Request(originUrl + url.pathname + url.search, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });

    const response = await fetch(originRequest);

    // Cache successful GET responses
    if (request.method === 'GET' && response.ok) {
      const responseBody = await response.clone().text();
      ctx.waitUntil(
        env.CACHE.put(url.pathname + url.search, responseBody, {
          expirationTtl: parseInt(env.CACHE_TTL || '3600')
        })
      );
    }

    // Add edge metadata
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-Edge-Region', request.cf?.colo || 'unknown');
    newResponse.headers.set('X-Cache', 'MISS');

    return newResponse;
  }
};

// Durable Object for session management
export class SessionManager {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    if (url.pathname === '/session') {
      const sessionId = url.searchParams.get('id');
      if (!sessionId) {
        return new Response('Missing session ID', { status: 400 });
      }

      // Get or create session
      const session = await this.state.storage.get(sessionId);
      if (!session) {
        const newSession = {
          id: sessionId,
          createdAt: Date.now(),
          lastAccess: Date.now()
        };
        await this.state.storage.put(sessionId, newSession);
        return new Response(JSON.stringify(newSession), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Update last access
      session.lastAccess = Date.now();
      await this.state.storage.put(sessionId, session);

      return new Response(JSON.stringify(session), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // Cron trigger for cleanup
  async alarm() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    const sessions = await this.state.storage.list();
    
    for (const [id, session] of sessions) {
      if (session.lastAccess < cutoff) {
        await this.state.storage.delete(id);
      }
    }
  }
}
`;

  return { wranglerToml, workerJs };
}

/**
 * Generate Deno Deploy configuration
 */
export function generateDenoDeploy(): {
  denoJson: string;
  modTs: string;
} {
  const denoJson = JSON.stringify({
    tasks: {
      start: 'deno run --allow-net --allow-env mod.ts',
      deploy: 'deployctl deploy --project=qwenproxy mod.ts'
    },
    imports: {
      'hono': 'https://deno.land/x/hono@v4.0.0/mod.ts',
      'std/': 'https://deno.land/std@0.200.0/'
    }
  }, null, 2);

  const modTs = `
// QwenProxy Edge Worker for Deno Deploy
import { Hono } from 'hono';

const app = new Hono();

const ORIGIN_URL = Deno.env.get('ORIGIN_URL') || 'http://localhost:3000';

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    platform: 'deno-deploy',
    region: Deno.env.get('DENO_REGION') || 'unknown',
    timestamp: Date.now()
  });
});

// Proxy all other requests to origin
app.all('*', async (c) => {
  const url = new URL(c.req.url);
  const originRequest = new Request(ORIGIN_URL + url.pathname + url.search, {
    method: c.req.method,
    headers: c.req.headers,
    body: c.req.raw.body
  });

  const response = await fetch(originRequest);
  
  // Add edge metadata
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('X-Edge-Platform', 'deno-deploy');
  newResponse.headers.set('X-Edge-Region', Deno.env.get('DENO_REGION') || 'unknown');

  return newResponse;
});

Deno.serve(app.fetch);
`;

  return { denoJson, modTs };
}

/**
 * Calculate optimal edge regions based on user distribution
 */
export function calculateOptimalRegions(userLocations: Array<{ country: string; count: number }>): string[] {
  const regionMap: Record<string, string[]> = {
    'North America': ['na-east', 'na-west'],
    'Europe': ['eu-west', 'eu-central'],
    'Asia': ['asia-east', 'asia-south'],
    'South America': ['sa-east'],
    'Africa': ['af-south'],
    'Oceania': ['oc-east'],
  };

  const regionScores = new Map<string, number>();

  for (const { country, count } of userLocations) {
    // Map country to region (simplified)
    let region = 'na-east'; // default
    if (country.match(/US|CA|MX/i)) region = 'na-west';
    else if (country.match(/BR|AR|CL/i)) region = 'sa-east';
    else if (country.match(/GB|DE|FR|IT|ES/i)) region = 'eu-west';
    else if (country.match(/CN|JP|KR|TW/i)) region = 'asia-east';
    else if (country.match(/IN|SG|TH/i)) region = 'asia-south';
    else if (country.match(/AU|NZ/i)) region = 'oc-east';

    regionScores.set(region, (regionScores.get(region) || 0) + count);
  }

  // Sort by traffic and take top 3
  const sorted = Array.from(regionScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([region]) => region);

  return sorted.length > 0 ? sorted : ['auto'];
}

/**
 * Estimate latency reduction from edge deployment
 */
export function estimateLatencyReduction(
  currentAvgLatencyMs: number,
  userRegions: string[]
): { estimatedReduction: number; newAvgLatency: number } {
  // Typical latency reduction: 40-70% depending on user distribution
  const reductionFactor = userRegions.length > 3 ? 0.6 : 0.4;
  const estimatedReduction = currentAvgLatencyMs * reductionFactor;
  const newAvgLatency = currentAvgLatencyMs - estimatedReduction;

  return {
    estimatedReduction: Math.round(estimatedReduction),
    newAvgLatency: Math.round(newAvgLatency),
  };
}

/**
 * Update edge config
 */
export function setEdgeConfig(partial: Partial<EdgeConfig>): void {
  config = { ...config, ...partial };
  console.log('[Edge] Config updated:', config);
}

/**
 * Get current config
 */
export function getEdgeConfig(): EdgeConfig {
  return { ...config };
}

/**
 * Generate deployment instructions
 */
export function getDeploymentInstructions(provider: 'cloudflare' | 'deno'): string {
  if (provider === 'cloudflare') {
    return `
# Cloudflare Workers Deployment

1. Install Wrangler CLI:
   npm install -g wrangler

2. Login to Cloudflare:
   wrangler login

3. Create KV namespace:
   wrangler kv:namespace create CACHE

4. Update wrangler.toml with your KV namespace ID

5. Deploy:
   wrangler deploy

6. Set environment variables:
   wrangler secret put ORIGIN_URL
   # Enter your origin URL (e.g., https://your-vps.com:3000)

7. Test:
   curl https://qwenproxy-edge.your-subdomain.workers.dev/health
`;
  }

  return `
# Deno Deploy

1. Install Deno:
   curl -fsSL https://deno.land/install.sh | sh

2. Install deployctl:
   deno install -A https://deno.land/x/deploy/deployctl.ts

3. Login:
   deployctl login

4. Deploy:
   deployctl deploy --project=qwenproxy mod.ts

5. Set environment variables in Deno Deploy dashboard:
   ORIGIN_URL=https://your-vps.com:3000

6. Test:
   curl https://qwenproxy.deno.dev/health
`;
}
