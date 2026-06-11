/*
 * Tests: multi-tenant.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTenant, authenticateTenant, canMakeRequest, isModelAllowed } from '../core/multi-tenant.js';

describe('MultiTenant', () => {
  it('deve criar tenant com API key', () => {
    const tenant = createTenant('Test Tenant ' + Date.now());
    assert.ok(tenant.id);
    assert.ok(tenant.apiKey.startsWith('sk-'));
    assert.strictEqual(tenant.status, 'active');
  });

  it('deve autenticar tenant válido', () => {
    const tenant = createTenant('Auth Test ' + Date.now());
    const auth = authenticateTenant(tenant.apiKey);
    assert.ok(auth);
    assert.strictEqual(auth.id, tenant.id);
  });

  it('deve rejeitar API key inválida', () => {
    const auth = authenticateTenant('sk-invalid-key');
    assert.strictEqual(auth, null);
  });

  it('deve permitir request dentro dos limites', () => {
    const tenant = createTenant('Limit Test ' + Date.now());
    const result = canMakeRequest(tenant);
    assert.strictEqual(result.allowed, true);
  });

  it('deve permitir todos os modelos quando lista vazia', () => {
    const tenant = createTenant('Model Test ' + Date.now());
    assert.strictEqual(isModelAllowed(tenant, 'qwen3.7-plus'), true);
    assert.strictEqual(isModelAllowed(tenant, 'qwen3.6-27b'), true);
  });
});
