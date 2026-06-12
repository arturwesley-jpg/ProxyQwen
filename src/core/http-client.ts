import { Agent, Dispatcher } from 'undici';
import CacheableLookup from 'cacheable-lookup';

// Cache de DNS para evitar resoluções repetidas (TTL de 5 minutos)
const dnsCache = new CacheableLookup({ maxTtl: 300 });

/**
 * Creates a new undici Agent with optimized settings.
 * This function allows creating fresh agents for testing (with mocked dispatchers).
 */
export function createQwenAgent(): Agent {
  return new Agent({
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 600000,
    connections: 50,
    pipelining: 1,
  } as any);
}

// Default production agent (singleton)
export const qwenAgent = createQwenAgent();

/**
 * Allows replacing the global qwenAgent for testing.
 * Call with a custom Dispatcher (e.g., MockAgent) in test setup.
 * Call resetQwenAgent() to restore the default.
 */
let _customAgent: Dispatcher | null = null;

export function setQwenAgent(agent: Dispatcher): void {
  _customAgent = agent;
}

export function getQwenAgent(): Dispatcher {
  return _customAgent ?? qwenAgent;
}

export function resetQwenAgent(): void {
  _customAgent = null;
}
