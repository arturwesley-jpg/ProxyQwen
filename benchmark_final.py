#!/usr/bin/env python3
"""
Final benchmark: Test the 8 specific Qwen models with ONE request each
With longer delays and server recovery between models
"""

import json
import time
import gzip
from typing import List
import aiohttp
import asyncio

BASE_URL = "http://localhost:3000"
API_KEY = "qwenproxy-secret-key-2026"
MODELS = [
    "qwen3.7-plus",
    "qwen3.7-plus-no-thinking",
    "qwen3.7-max",
    "qwen3.7-max-no-thinking",
    "qwen3.6-plus",
    "qwen3.6-plus-no-thinking",
    "qwen3.6-max-preview",
    "qwen3.6-max-preview-no-thinking",
]

TEST_MESSAGE = "What is Python? Brief answer."

results = []

async def send_request(session: aiohttp.ClientSession, model: str) -> dict:
    url = f"{BASE_URL}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": TEST_MESSAGE}],
        "stream": False,
    }

    start = time.perf_counter()
    try:
        async with session.post(url, headers=headers, json=payload, timeout=aiohttp.ClientTimeout(total=180)) as resp:
            raw_body = await resp.read()
            elapsed = (time.perf_counter() - start) * 1000

            if len(raw_body) >= 2 and raw_body[:2] == b'\x1f\x8b':
                body = gzip.decompress(raw_body).decode('utf-8')
            else:
                body = raw_body.decode('utf-8')

            if resp.status == 200:
                try:
                    data = json.loads(body)
                    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                    return {
                        "model": model,
                        "success": True,
                        "response_time_ms": elapsed,
                        "content_length": len(content),
                        "content": content[:100],
                    }
                except json.JSONDecodeError as e:
                    return {"model": model, "success": False, "response_time_ms": elapsed, "content_length": 0, "error": f"JSON decode: {e}"}
            else:
                return {"model": model, "success": False, "response_time_ms": elapsed, "content_length": 0, "error": body[:200]}
    except asyncio.TimeoutError:
        elapsed = (time.perf_counter() - start) * 1000
        return {"model": model, "success": False, "response_time_ms": elapsed, "content_length": 0, "error": "Timeout"}
    except Exception as e:
        elapsed = (time.perf_counter() - start) * 1000
        return {"model": model, "success": False, "response_time_ms": elapsed, "content_length": 0, "error": str(e)[:200]}

async def check_health():
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{BASE_URL}/health", timeout=aiohttp.ClientTimeout(total=10)) as resp:
                return resp.status == 200
    except:
        return False

async def main():
    print("QwenProxy Final Benchmark: 8 Models x 1 Request Each")
    print(f"Base URL: {BASE_URL}")
    print(f"Models: {len(MODELS)}")

    connector = aiohttp.TCPConnector(limit=1, force_close=True)
    timeout = aiohttp.ClientTimeout(total=180)
    
    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        for i, model in enumerate(MODELS):
            healthy = await check_health()
            if not healthy:
                print(f"\n[{i+1}/{len(MODELS)}] Server unhealthy, waiting 30s...")
                await asyncio.sleep(30)
                healthy = await check_health()
                if not healthy:
                    print(f"  Server still unhealthy, skipping {model}")
                    results.append({"model": model, "success": False, "error": "Server unhealthy"})
                    continue

            print(f"\n[{i+1}/{len(MODELS)}] Testing: {model}")
            result = await send_request(session, model)
            results.append(result)
            
            if result["success"]:
                print(f"  ✓ {result['response_time_ms']:.0f}ms | {result['content_length']} chars | {result['content']}")
            else:
                print(f"  ✗ {result['error']}")
            
            if i < len(MODELS) - 1:
                print(f"  Waiting 20s for cleanup...")
                await asyncio.sleep(20)

    print(f"\n{'='*70}")
    print("FINAL BENCHMARK SUMMARY")
    print(f"{'='*70}")
    print(f"{'Model':<38} {'Status':<8} {'Time (ms)':>10} {'Chars':>8}")
    print("-" * 70)
    
    times = []
    for r in results:
        status = "OK" if r["success"] else "FAIL"
        time_str = f"{r.get('response_time_ms', 0):.0f}" if r["success"] else "N/A"
        chars = r.get('content_length', 0) if r["success"] else 0
        print(f"{r['model']:<38} {status:<8} {time_str:>10} {chars:>8}")
        if r["success"]:
            times.append(r["response_time_ms"])

    if times:
        print(f"\nSuccessful: {len(times)}/{len(results)}")
        print(f"Average: {sum(times)/len(times):.0f}ms | Min: {min(times):.0f}ms | Max: {max(times):.0f}ms")
        
        print(f"\n{'Model':<38} {'Time (ms)':>10} vs thinking:")
        print("-" * 55)
        for i in range(0, len(results), 2):
            if i+1 < len(results):
                thinking = results[i]
                no_thinking = results[i+1]
                if thinking["success"] and no_thinking["success"]:
                    speedup = ((thinking["response_time_ms"] - no_thinking["response_time_ms"]) / thinking["response_time_ms"]) * 100
                    print(f"{no_thinking['model']:<38} {no_thinking['response_time_ms']:>10.0f}  {speedup:.0f}% faster")

if __name__ == "__main__":
    asyncio.run(main())