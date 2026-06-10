import { Agent } from 'undici';
import CacheableLookup from 'cacheable-lookup';

// Cache de DNS para evitar resoluções repetidas (TTL de 5 minutos)
const dnsCache = new CacheableLookup({ maxTtl: 300 });

// Agent otimizado com Keep-Alive persistente para reutilizar conexões TCP/TLS
export const qwenAgent = new Agent({
  keepAliveTimeout: 60000,      // Manter conexão viva por 60s
  keepAliveMaxTimeout: 600000,  // Máximo de 10 minutos
  connections: 50,              // Até 50 conexões simultâneas por origem
  pipelining: 1,
  connect: {
    lookup: dnsCache.lookup.bind(dnsCache) as any,
  },
} as any);
