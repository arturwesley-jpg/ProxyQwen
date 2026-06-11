/*
 * Tests: context-summarizer.ts (needsSummarization only)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { needsSummarization, setSummarizerConfig } from '../utils/context-summarizer.js';

describe('ContextSummarizer', () => {
  it('deve retornar false quando desabilitado', () => {
    setSummarizerConfig({ enabled: false });
    const messages = Array(100).fill({ role: 'user', content: 'x' });
    assert.strictEqual(needsSummarization(messages, 'qwen3.7-plus'), false);
  });

  it('deve retornar false para poucas mensagens', () => {
    setSummarizerConfig({ enabled: true, keepRecentMessages: 5 });
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    assert.strictEqual(needsSummarization(messages, 'qwen3.7-plus'), false);
  });

  it('deve detectar necessidade de sumarização', () => {
    setSummarizerConfig({ enabled: true, threshold: 0.01 }); // threshold muito baixo
    const bigContent = 'word '.repeat(10000);
    const messages = Array(20).fill({ role: 'user', content: bigContent });
    const result = needsSummarization(messages, 'qwen3.6-27b');
    assert.strictEqual(result, true);
  });
});
