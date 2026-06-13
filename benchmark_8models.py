#!/usr/bin/env python3
"""
Benchmark: Test the 8 specific Qwen models with 4 messages each using 8 accounts in parallel
"""

import asyncio
import json
import time
import statistics
import gzip
from dataclasses import dataclass
from typing import List, Dict
import aiohttp

# Configuration
BASE_URL = "http://localhost:3000"
API_KEY = "qwenpr...et"  # Truncated for security

# 8 accounts with their IDs from the database
ACCOUNTS = [
    {"id": "bd6d7b5a-e77e-4725-91ee-7ec9bee925dc", "email": "asdf20022026@outlook.com"},
    {"id": "e091f929-a055-4a12-b219-4bd57e7a05f2", "email": "geen.trid02@outlook.com"},
    {"id": "aaec5962-4154-4db2-a3cf-51c7a65aa431", "email": "geen.trid03@outlook.com"},
    {"id": "565ed9a3-a43b-4477-9060-1dfb7042990d", "email": "wsxcderfvv1@outlook.com"},
    {"id": "97377daf-50e7-4b4f-af1e-2cc9bbee3821", "email": "homemmal0001@outlook.com"},
    {"id": "d944bade-2bb7-49a6-ba34-feb209a2805b", "email": "rewq202608@outlook.com"},
    {"id": "8020ae54-0b17-4da4-820d-17216e1815c6", "email": "qwe19462026@outlook.com"},
    {"id": "b8c03c82-e778-4ab2-a713-a6955540096a", "email": "zxh00012026@outlook.com"},
]

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

# 4 test messages per model
TEST_MESSAGES = [
    "What is Python? Brief answer.",
    "Explain async/await in JavaScript in 2 sentences.",
    "Write a hello world function in Go.",
    "What is the capital of Brazil?",
]

@dataclass
class BenchmarkResult:
    model: str
    account_id: str
    account_email: str
    message: str
    success: bool
    response_time_ms: float
    status_code: int
    content_length: int
    error: str = ""

async def send_request(session: aiohttp.ClientSession, model: str, message: str, account: dict, msg_idx: int, model_idx: int) -> BenchmarkResult:
    """Send a single request to the chat completions endpoint."""
    url = f"{BASE_URL}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "X-Account-Id": account["id"],
        "X-Agent-Id": f"bench-{model.replace('.', '-')}-m{model_idx}-msg{msg_idx}",
        "Accept-Encoding": "gzip",
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": message}],
        "stream": False,
    }

    start = time.perf_counter()
    try:
        async with session.post(url, headers=headers, json=payload, timeout=aiohttp.ClientTimeout(total=60)) as resp:
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
                    return BenchmarkResult(
                        model=model,
                        account_id=account["id"],
                        account_email=account["email"],
                        message=message,
                        success=True,
                        response_time_ms=elapsed,
                        status_code=resp.status,
                        content_length=len(content),
                    )
                except json.JSONDecodeError as e:
                    return BenchmarkResult(
                        model=model,
                        account_id=account["id"],
                        account_email=account["email"],
                        message=message,
                        success=False,
                        response_time_ms=elapsed,
                        status_code=resp.status,
                        content_length=0,
                        error=f"JSON decode error: {e}",
                    )
            else:
                return BenchmarkResult(
                    model=model,
                    account_id=account["id"],
                    account_email=account["email"],
                    message=message,
                    success=False,
                    response_time_ms=elapsed,
                    status_code=resp.status,
                    content_length=0,
                    error=body[:200],
                )
    except asyncio.TimeoutError:
        elapsed = (time.perf_counter() - start) * 1000
        return BenchmarkResult(
            model=model,
            account_id=account["id"],
            account_email=account["email"],
            message=message,
            success=False,
            response_time_ms=elapsed,
            status_code=408,
            content_length=0,
            error="Timeout",
        )
    except Exception as e:
        elapsed = (time.perf_counter() - start) * 1000
        return BenchmarkResult(
            model=model,
            account_id=account["id"],
            account_email=account["email"],
            message=message,
            success=False,
            response_time_ms=elapsed,
            status_code=0,
            content_length=0,
            error=str(e)[:200],
        )

async def run_model_benchmark(model: str, model_idx: int) -> List[BenchmarkResult]:
    """Run 4 messages for a single model across 8 accounts in parallel."""
    print(f"\n{'='*60}")
    print(f"Testing model: {model}")
    print(f"{'='*60}")

    connector = aiohttp.TCPConnector(limit=20)
    timeout = aiohttp.ClientTimeout(total=60)
    
    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        tasks = []
        for i, message in enumerate(TEST_MESSAGES):
            # Distribute messages across accounts (round-robin)
            account = ACCOUNTS[i % len(ACCOUNTS)]
            task = send_request(session, model, message, account, i, model_idx)
            tasks.append(task)

        results = await asyncio.gather(*tasks, return_exceptions=True)

    valid_results = []
    for r in results:
        if isinstance(r, BenchmarkResult):
            valid_results.append(r)
        else:
            print(f"  ERROR: {r}")

    return valid_results

async def main():
    print("QwenProxy Benchmark: 8 Models x 4 Messages x 8 Accounts")
    print(f"Base URL: {BASE_URL}")
    print(f"Accounts: {len(ACCOUNTS)}")
    print(f"Models: {len(MODELS)}")
    print(f"Messages per model: {len(TEST_MESSAGES)}")

    all_results = []

    for model_idx, model in enumerate(MODELS):
        results = await run_model_benchmark(model, model_idx)
        all_results.extend(results)

        # Quick summary for this model
        successful = [r for r in results if r.success]
        if successful:
            times = [r.response_time_ms for r in successful]
            print(f"  ✓ Successful: {len(successful)}/{len(results)}")
            print(f"  ⏱ Avg: {statistics.mean(times):.0f}ms | Min: {min(times):.0f}ms | Max: {max(times):.0f}ms")
        else:
            print(f"  ✗ All failed")
            for r in results:
                print(f"    {r.account_email[:20]}: {r.error[:80]}")

        # Delay between models to avoid rate limits and let locks clear
        await asyncio.sleep(5)

    # Save detailed results to CSV
    csv_path = f"benchmark_results_{int(time.time())}.csv"
    with open(csv_path, "w") as f:
        f.write("model,account_id,account_email,message,success,response_time_ms,status_code,content_length,error\n")
        for r in all_results:
            f.write(f'"{r.model}","{r.account_id}","{r.account_email}","{r.message}",{r.success},{r.response_time_ms:.0f},{r.status_code},{r.content_length},"{r.error}"\n')
    print(f"\n📊 Detailed results saved to: {csv_path}")

    # Overall summary
    print(f"\n{'='*60}")
    print("OVERALL SUMMARY")
    print(f"{'='*60}")

    successful_results = [r for r in all_results if r.success]
    print(f"Total requests: {len(all_results)}")
    print(f"Successful: {len(successful_results)}")
    print(f"Failed: {len(all_results) - len(successful_results)}")

    if successful_results:
        by_model: Dict[str, List[float]] = {}
        for r in successful_results:
            if r.model not in by_model:
                by_model[r.model] = []
            by_model[r.model].append(r.response_time_ms)

        print(f"\n{'Model':<35} {'Requests':>8} {'Avg (ms)':>10} {'Min (ms)':>10} {'Max (ms)':>10}")
        print("-" * 75)
        for model in MODELS:
            if model in by_model:
                times = by_model[model]
                print(f"{model:<35} {len(times):>8} {statistics.mean(times):>10.0f} {min(times):>10.0f} {max(times):>10.0f}")
            else:
                print(f"{model:<35} {'N/A':>8}")

        # Overall stats
        all_times = [r.response_time_ms for r in successful_results]
        print(f"\nOverall average: {statistics.mean(all_times):.0f}ms")
        print(f"Overall median: {statistics.median(all_times):.0f}ms")

if __name__ == "__main__":
    asyncio.run(main())