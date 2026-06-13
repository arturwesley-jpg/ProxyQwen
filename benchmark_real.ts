#!/usr/bin/env node --import=tsx
/**
 * Benchmark real: testa todos os 8 modelos com 4 mensagens cada
 * Mede latência, throughput e erros
 */

const API_KEY = '***';
const BASE_URL = 'http://localhost:3000/v1';

const MODELS = [
  'qwen3.7-plus',
  'qwen3.7-plus-no-thinking',
  'qwen3-coder-plus',
  'qwen3-coder-plus-no-thinking',
  'qwen3-vl-plus',
  'qwen3-vl-plus-no-thinking',
];

const MESSAGES = [
  { role: 'user', content: 'Olá, tudo bem?' },
  { role: 'user', content: 'Explique o que é TypeScript em 2 frases.' },
  { role: 'user', content: 'Escreva uma função Python para ordenar uma lista.' },
  { role: 'user', content: 'Qual a capital da França?' },
];

async function sendRequest(model: string, messages: any[], stream = false) {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ model, messages, stream }),
    });
    
    const data = await res.json();
    const latency = Date.now() - start;
    
    return {
      success: res.ok,
      latency,
      status: res.status,
      usage: data.usage,
      error: data.error?.message,
    };
  } catch (e) {
    return {
      success: false,
      latency: Date.now() - start,
      error: String(e),
    };
  }
}

async function benchmarkStream(model: string) {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ model, messages: MESSAGES, stream: true }),
    });
    
    if (!res.ok) {
      const data = await res.json();
      return { success: false, latency: Date.now() - start, error: data.error?.message };
    }
    
    const reader = res.body?.getReader();
    if (!reader) return { success: false, latency: Date.now() - start, error: 'No reader' };
    
    let firstTokenTime = 0;
    let totalTokens = 0;
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content) {
              if (firstTokenTime === 0) firstTokenTime = Date.now() - start;
              totalTokens++;
            }
            if (data.usage) totalTokens = data.usage.completion_tokens || totalTokens;
          } catch {}
        }
      }
    }
    
    return {
      success: true,
      latency: Date.now() - start,
      firstTokenLatency: firstTokenTime,
      totalTokens,
    };
  } catch (e) {
    return { success: false, latency: Date.now() - start, error: String(e) };
  }
}

async function run() {
  console.log('🚀 Iniciando benchmark real com 8 contas...\n');
  
  const results: any = {};
  
  for (const model of MODELS) {
    console.log(`\n📊 Testando modelo: ${model}`);
    const modelResults: any = { nonStream: [], stream: [] };
    
    // 4 requisições non-stream
    for (let i = 0; i < MESSAGES.length; i++) {
      const msgs = MESSAGES.slice(0, i + 1);
      const r = await sendRequest(model, msgs, false);
      modelResults.nonStream.push(r);
      console.log(`  Non-stream [${i+1}/4]: ${r.success ? '✅' : '❌'} ${r.latency}ms ${r.error || ''}`);
      await new Promise(r => setTimeout(r, 500));
    }
    
    // 4 requisições stream
    for (let i = 0; i < MESSAGES.length; i++) {
      const msgs = MESSAGES.slice(0, i + 1);
      const r = await benchmarkStream(model);
      modelResults.stream.push(r);
      console.log(`  Stream [${i+1}/4]: ${r.success ? '✅' : '❌'} ${r.latency}ms (first: ${r.firstTokenLatency}ms, tokens: ${r.totalTokens}) ${r.error || ''}`);
      await new Promise(r => setTimeout(r, 500));
    }
    
    results[model] = modelResults;
  }
  
  // Summary
  console.log('\n\n📈 RESUMO DO BENCHMARK');
  console.log('='.repeat(80));
  
  for (const [model, data] of Object.entries(results)) {
    const ns = data.nonStream.filter((r: any) => r.success);
    const s = data.stream.filter((r: any) => r.success);
    
    const avgNs = ns.length ? ns.reduce((a: number, r: any) => a + r.latency, 0) / ns.length : 0;
    const avgS = s.length ? s.reduce((a: number, r: any) => a + r.latency, 0) / s.length : 0;
    const avgFirst = s.length ? s.reduce((a: number, r: any) => a + (r.firstTokenLatency || 0), 0) / s.length : 0;
    const totalTokens = s.reduce((a: number, r: any) => a + (r.totalTokens || 0), 0);
    
    console.log(`${model}:`);
    console.log(`  Non-stream: ${ns.length}/4 OK | Avg: ${avgNs.toFixed(0)}ms`);
    console.log(`  Stream:     ${s.length}/4 OK | Avg: ${avgS.toFixed(0)}ms | First token: ${avgFirst.toFixed(0)}ms | Tokens: ${totalTokens}`);
  }
  
  console.log('\n✅ Benchmark completo!');
}

run().catch(console.error);