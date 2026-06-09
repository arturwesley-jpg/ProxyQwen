import { test } from 'node:test';
import assert from 'node:assert';
import { estimateTokenCount, truncateMessages } from '../utils/context-truncation.js';

test('estimateTokenCount: returns 0 for empty string', () => {
  assert.strictEqual(estimateTokenCount(''), 0);
});

test('estimateTokenCount: estimates tokens conservatively using 2.5 divisor', () => {
  assert.strictEqual(estimateTokenCount('hello'), 2);
  assert.strictEqual(estimateTokenCount('a'.repeat(100)), 40);
  assert.strictEqual(estimateTokenCount('a'.repeat(250)), 100);
  assert.strictEqual(estimateTokenCount('a'.repeat(2500)), 1000);
});

test('estimateTokenCount: handles single character', () => {
  assert.strictEqual(estimateTokenCount('x'), 1);
});

test('estimateTokenCount: rounds up for non-multiples of 2.5', () => {
  assert.strictEqual(estimateTokenCount('ab'), 1);
  assert.strictEqual(estimateTokenCount('abc'), 2);
  assert.strictEqual(estimateTokenCount('abcd'), 2);
});

test('truncateMessages: returns all messages when within context window', () => {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
  ];
  const result = truncateMessages(messages, 100000);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].content, 'You are helpful.');
  assert.strictEqual(result[1].content, 'Hello');
  assert.strictEqual(result[2].content, 'Hi there!');
});

test('truncateMessages: preserves chronological order', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ];
  const result = truncateMessages(messages, 100000);
  assert.strictEqual(result[0].role, 'user');
  assert.strictEqual(result[0].content, 'first');
  assert.strictEqual(result[1].role, 'assistant');
  assert.strictEqual(result[2].role, 'user');
  assert.strictEqual(result[2].content, 'third');
});

test('truncateMessages: drops oldest messages first when exceeding context', () => {
  const largeContent = 'x'.repeat(5000);
  const messages = [
    { role: 'user', content: largeContent },
    { role: 'assistant', content: largeContent },
    { role: 'user', content: 'latest message' },
  ];
  const result = truncateMessages(messages, 2000);
  const lastMsg = result[result.length - 1];
  assert.ok(lastMsg.content.includes('latest message') || lastMsg.content.includes('[Truncated]'));
});

test('truncateMessages: returns system prompt as fallback when context is extremely small', () => {
  const messages = [
    { role: 'user', content: 'some content' },
  ];
  const systemPrompt = 'system instructions';
  const result = truncateMessages(messages, 10, systemPrompt);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].role, 'user');
  assert.strictEqual(result[0].content, systemPrompt);
});

test('truncateMessages: handles array content in messages', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
      ],
    },
  ];
  const result = truncateMessages(messages, 100000);
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].content.includes('hello'));
});

test('truncateMessages: handles null content', () => {
  const messages = [
    { role: 'user', content: null },
    { role: 'assistant', content: 'response' },
  ];
  const result = truncateMessages(messages, 100000);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].content, '');
  assert.strictEqual(result[1].content, 'response');
});

test('truncateMessages: handles object content', () => {
  const messages = [
    { role: 'user', content: { structured: 'data', value: 42 } },
  ];
  const result = truncateMessages(messages, 100000);
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].content.includes('structured'));
});

test('truncateMessages: truncates partially fitting message with marker', () => {
  const messages = [
    { role: 'user', content: 'a'.repeat(10000) },
  ];
  const result = truncateMessages(messages, 1000);
  assert.strictEqual(result.length, 1);
  assert.ok(
    result[0].content.includes('[Truncated]') || result[0].content.length < 10000,
    'Should truncate or mark as truncated'
  );
});

test('truncateMessages: accounts for system prompt in available tokens', () => {
  const systemPrompt = 'x'.repeat(2000);
  const messages = [
    { role: 'user', content: 'short' },
  ];
  const withSystem = truncateMessages(messages, 2000, systemPrompt);
  const withoutSystem = truncateMessages(messages, 2000);
  assert.ok(withSystem.length <= withoutSystem.length);
});

test('truncateMessages: handles empty messages array', () => {
  const result = truncateMessages([], 100000);
  assert.strictEqual(result.length, 0);
});

test('truncateMessages: handles empty messages with system prompt fallback', () => {
  const result = truncateMessages([], 5, 'fallback');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].content, 'fallback');
});
