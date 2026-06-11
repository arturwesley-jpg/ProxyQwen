/*
 * Tests: edge-deployment.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateCloudflareWorker, generateDenoDeploy, estimateLatencyReduction } from '../core/edge-deployment.js';

describe('EdgeDeployment', () => {
  it('deve gerar Cloudflare Worker', () => {
    const result = generateCloudflareWorker();
    assert.ok(result.wranglerToml.includes('name = "qwenproxy-edge"'));
    assert.ok(result.workerJs.includes('export default'));
  });

  it('deve gerar Deno Deploy config', () => {
    const result = generateDenoDeploy();
    assert.ok(result.denoJson.includes('start'));
    assert.ok(result.modTs.includes('Deno.serve'));
  });

  it('deve estimar redução de latência', () => {
    const result = estimateLatencyReduction(1000, ['na-east', 'eu-west', 'asia-east']);
    assert.ok(result.estimatedReduction > 0);
    assert.ok(result.newAvgLatency < 1000);
    assert.ok(result.newAvgLatency > 0);
  });
});
