#!/usr/bin/env python3
"""
Simple benchmark: Test the 8 specific Qwen models with ONE request each
to avoid OOM kills
"""

import json
import time
import gzip
from typing import List
import aiohttp
import asyncio

# Configuration
BASE_URL = "http://localhost:3000"
API_KEY = "qwenproxy-secret-key-2026"

# 8 Main models to test (the primary Qwen models as requested)
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

# 1 test message per model
TEST_MESSAGE = "What is Python? Brief answer."

results = []

async def send_request(session: aiohttp.ClientSession, model: str) -> dict:
    """Send a single request to the chat completions endpoint."""
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
        async with session.post(url, headers=headers, json=payload, timeout=aiohttp.ClientTimeout(total=120)) as resp:
            raw_body = await resp.read()
            elapsed = (time.perf_counter() - start) * 1000

            # Handle gzip response
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
                    return {
                        "model": model,
                        "success": False,
                        "response_time_ms": elapsed,
                        "content_length": 0,
                        "error": f"JSON decode error: {e}",
                    }
            else:
                return {
                    "model": model,
                    "success": False,
                    "response_time_ms": elapsed,
                    "content_length": 0,
                    "error": body[:200],
                }
    except asyncio.TimeoutError:
        elapsed = (time.perf_counter() - start) * 1000
        return {
            "model": model,
            "success": False,
            "response_time_ms": elapsed,
            "content_length": 0,
            "error": "Timeout",
        }
    except Exception as e:
        elapsed = (time.perf_counter() - start) * 1000
        return {
            "model": model,
            "success": False,
            "response_time_ms": elapsed,
            "content_length": 0,
            "error": str(e)[:200],
        }

async def main():
    print("QwenProxy Benchmark: 8 Models x 1 Request Each")
    print(f"Base URL: {BASE_URL}")
    print(f"Models: {len(MODELS)}")

    connector = aiohttp.TCPConnector(limit=2)
    timeout = aiohttp.ClientTimeout(total=120)
    
    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        for i, model in enumerate(MODELS):
            print(f"\n[{i+1}/{len(MODELS)}] Testing: {model}")
            result = await send_request(session, model)
            results.append(result)
            
            if result["success"]:
                print(f"  ✓ {result['response_time_ms']:.0f}ms | {result['content_length']} chars | {result['content']}")
            else:
                print(f"  ✗ {result['error']}")
            
            # Delay between requests
            await asyncio.sleep(5)

    # Summary
    print(f"\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")
    print(f"{'Model':<38} {'Status':<8} {'Time (ms)':>10} {'Chars':>8}")
    print("-" * 70)
    
    for r in results:
        status = "OK" if r["success"] else "FAIL"
        time_str = f"{r['response_time_ms']:.0f}" if r["success"] else "N/A"
        chars = r['content_length'] if r["success"] else 0
        print(f"{r['model']:<38} {status:<8} {time_str:>10} {chars:>8}")

    successful = [r for r in results if r["success"]]
    if successful:
        times = [r["response_time_ms"] for r in successful]
        print(f"\nSuccessful: {len(successful)}/{len(results)}")
        avg_time = sum(times) / len(times)
        min_time = min(times)
        max_time = max(times)
        print(f"Average: {avg_time:.0f}ms | Min: {min_time:.0f}ms | Max: {max_time:.0f}ms")

if __name__ == "__main__":
    asyncio.run(main())