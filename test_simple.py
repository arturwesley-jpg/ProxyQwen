#!/usr/bin/env python3
"""
Teste simples com debug: 1 modelo, 4 mensagens, 4 contas SEQUENCIAL
"""

import asyncio
import json
import time
from dataclasses import dataclass
import aiohttp
import gzip

BASE_URL = "http://localhost:3000"
API_KEY="qwenproxy-secret-key-2026"
ACCOUNTS = [
    {"id": "bd6d7b5a-e77e-4725-91ee-7ec9bee925dc", "email": "asdf20022026@outlook.com"},
    {"id": "e091f929-a055-4a12-b219-4bd57e7a05f2", "email": "geen.trid02@outlook.com"},
    {"id": "aaec5962-4154-4db2-a3cf-51c7a65aa431", "email": "geen.trid03@outlook.com"},
    {"id": "565ed9a3-a43b-4477-9060-1dfb7042990d", "email": "wsxcderfvv1@outlook.com"},
]

MODEL = "qwen3.6-27b-no-thinking"
TEST_MESSAGES = [
    "What is Python? Brief answer.",
    "Explain async/await in JavaScript in 2 sentences.",
    "Write a hello world function in Go.",
    "What is the capital of Brazil?",
]

@dataclass
class Result:
    account_email: str
    success: bool
    response_time_ms: float
    status_code: int
    content: str = ""
    error: str = ""

async def send_request(account: dict, message: str, idx: int) -> Result:
    url = f"{BASE_URL}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "X-Account-Id": account["id"],
        "X-Agent-Id": f"test-{idx}",
        "Accept-Encoding": "gzip",
    }
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": message}],
        "stream": False,
    }
    
    print(f"  [DEBUG] Sending to {account['email']} with X-Account-Id: {account['id'][:8]}...")
    
    start = time.perf_counter()
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, headers=headers, json=payload, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                raw_body = await resp.read()
                elapsed = (time.perf_counter() - start) * 1000
                
                if len(raw_body) >= 2 and raw_body[:2] == b'\x1f\x8b':
                    body = gzip.decompress(raw_body).decode('utf-8')
                else:
                    body = raw_body.decode('utf-8')
                
                if resp.status == 200:
                    data = json.loads(body)
                    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                    return Result(account["email"], True, elapsed, resp.status, content)
                else:
                    return Result(account["email"], False, elapsed, resp.status, "", body[:200])
    except Exception as e:
        elapsed = (time.perf_counter() - start) * 1000
        return Result(account["email"], False, elapsed, 0, "", str(e)[:200])

async def main():
    print(f"Testando modelo: {MODEL}")
    print(f"Contas: {[a['email'] for a in ACCOUNTS]}")
    print("-" * 60)
    
    for i, (account, message) in enumerate(zip(ACCOUNTS, TEST_MESSAGES)):
        print(f"\n[{i+1}/4] {account['email']}: {message[:40]}...")
        result = await send_request(account, message, i)
        
        if result.success:
            print(f"  Sucesso: {result.response_time_ms:.0f}ms, {result.content[:80]}...")
        else:
            print(f"  Falha ({result.status_code}): {result.error[:120]}")
        
        if i < 3:
            print("  Aguardando 3s...")
            await asyncio.sleep(3)

if __name__ == "__main__":
    asyncio.run(main())