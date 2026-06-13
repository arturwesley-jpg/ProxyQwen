/*
 * Test file for rate-limiter and circuit-breaker
 */

import { rateLimiter } from './src/core/rate-limiter.js';
import { circuitBreakerRegistry } from './src/core/circuit-breaker.js';

async function testRateLimiter() {
  console.log('\n=== Testing Rate Limiter ===\n');

  // Test 1: Basic global limit
  console.log('Test 1: Global rate limit');
  for (let i = 0; i < 5; i++) {
    const result = rateLimiter.checkLimit(1);
    console.log(`  Request ${i + 1}: allowed=${result.allowed}, remaining=${result.remainingTokens}`);
  }

  // Test 2: Account-level limit
  console.log('\nTest 2: Account-level limit (account-1)');
  for (let i = 0; i < 5; i++) {
    const result = rateLimiter.checkLimit(1, 'account-1');
    console.log(`  Request ${i + 1}: allowed=${result.allowed}, remaining=${result.remainingTokens}`);
  }

  // Test 3: Tenant-level limit
  console.log('\nTest 3: Tenant-level limit (tenant-1)');
  for (let i = 0; i < 5; i++) {
    const result = rateLimiter.checkLimit(1, 'account-2', 'tenant-1');
    console.log(`  Request ${i + 1}: allowed=${result.allowed}, remaining=${result.remainingTokens}`);
  }

  // Test 4: Exhaust account limit
  console.log('\nTest 4: Exhaust account limit (account-3)');
  for (let i = 0; i < 12; i++) {
    const result = rateLimiter.checkLimit(1, 'account-3');
    if (!result.allowed) {
      console.log(`  Request ${i + 1}: REJECTED - retryAfter=${result.retryAfterMs}ms`);
      break;
    }
    console.log(`  Request ${i + 1}: allowed, remaining=${result.remainingTokens}`);
  }

  // Test 5: Stats
  console.log('\nTest 5: Stats');
  const globalStats = rateLimiter.getGlobalStats();
  console.log('  Global:', globalStats);

  const accountStats = rateLimiter.getAccountStats('account-1');
  console.log('  Account-1:', accountStats);

  const tenantStats = rateLimiter.getTenantStats('tenant-1');
  console.log('  Tenant-1:', tenantStats);

  // Test 6: Peek (non-consuming)
  console.log('\nTest 6: Peek (non-consuming check)');
  const peek1 = rateLimiter.peekLimit(1, 'account-4');
  console.log('  Peek 1:', peek1);
  const peek2 = rateLimiter.peekLimit(1, 'account-4');
  console.log('  Peek 2:', peek2);

  // Test 7: Reset
  console.log('\nTest 7: Reset account');
  rateLimiter.resetAccount('account-3');
  const afterReset = rateLimiter.checkLimit(1, 'account-3');
  console.log('  After reset:', afterReset);

  console.log('\n✓ Rate limiter tests passed');
}

async function testCircuitBreaker() {
  console.log('\n=== Testing Circuit Breaker ===\n');

  const registry = circuitBreakerRegistry;

  // Test 1: Success path
  console.log('Test 1: Successful requests (CLOSED state)');
  const breaker = registry.getBreaker('test-service');

  for (let i = 0; i < 3; i++) {
    const result = await breaker.execute(async () => {
      return 'success';
    });
    console.log(`  Request ${i + 1}: success=${result.success}, state=${result.state}`);
  }

  console.log('  Stats:', breaker.getStats());

  // Test 2: Failure threshold
  console.log('\nTest 2: Trigger OPEN state with failures');
  const failBreaker = registry.getBreaker('failing-service', { failureThreshold: 3, resetTimeoutMs: 1000 });

  for (let i = 0; i < 5; i++) {
    const result = await failBreaker.execute(async () => {
      throw new Error('Simulated failure');
    });
    console.log(`  Request ${i + 1}: success=${result.success}, state=${result.state}`);
  }

  console.log('  Stats after failures:', failBreaker.getStats());

  // Test 3: Rejection while OPEN
  console.log('\nTest 3: Requests rejected while OPEN');
  for (let i = 0; i < 3; i++) {
    const result = await failBreaker.execute(async () => 'success');
    console.log(`  Request ${i + 1}: success=${result.success}, state=${result.state}, error=${result.error?.message}`);
  }

  // Test 4: Wait for HALF_OPEN and recover
  console.log('\nTest 4: Wait for reset timeout and recover');
  console.log('  Waiting 1.5s for reset timeout...');
  await new Promise(r => setTimeout(r, 1500));

  for (let i = 0; i < 3; i++) {
    const result = await failBreaker.execute(async () => 'success');
    console.log(`  Request ${i + 1}: success=${result.success}, state=${result.state}`);
  }

  console.log('  Final stats:', failBreaker.getStats());

  // Test 5: Registry stats
  console.log('\nTest 5: Registry stats');
  const allStats = registry.getAllStats();
  console.log('  All breakers:', allStats);

  // Test 6: Force open/reset
  console.log('\nTest 6: Manual control');
  const manualBreaker = registry.getBreaker('manual-service');
  manualBreaker.forceOpen();
  console.log('  After forceOpen:', manualBreaker.getState());

  manualBreaker.reset();
  console.log('  After reset:', manualBreaker.getState());

  console.log('\n✓ Circuit breaker tests passed');
}

async function main() {
  try {
    await testRateLimiter();
    await testCircuitBreaker();
    console.log('\n=== All Tests Passed ===');
  } catch (err) {
    console.error('\n✗ Tests failed:', err);
    process.exit(1);
  } finally {
    // Cleanup
    rateLimiter.shutdown();
    circuitBreakerRegistry.shutdown();
  }
}

main();