/*
 * File: sse-parser.worker.ts
 * Project: qwenproxy
 * Worker thread for offloading SSE parsing from main event loop
 */

import { parentPort } from 'worker_threads';

export interface ParsedEvent {
  type: 'content' | 'thinking' | 'tool_call' | 'usage' | 'response_created' | 'done' | 'error';
  data: any;
}

interface WorkerMessage {
  type: 'parse';
  id: string;
  chunks: string[];
}

interface WorkerResponse {
  type: 'result' | 'error';
  id: string;
  events?: ParsedEvent[];
  error?: string;
}

/**
 * Parse SSE chunks into structured events
 * Minimal reimplementation of qwen-stream-parser logic
 */
function parseSSEChunks(chunks: string[]): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const buffer = chunks.join('');
  const lines = buffer.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data: ')) continue;

    const dataStr = trimmed.slice(6);
    if (dataStr === '[DONE]') {
      events.push({ type: 'done', data: null });
      continue;
    }

    try {
      const chunk = JSON.parse(dataStr);

      // Response created event
      if (chunk['response.created']?.response_id) {
        events.push({
          type: 'response_created',
          data: { responseId: chunk['response.created'].response_id }
        });
        continue;
      }

      // Response ID at top level
      if (chunk.response_id) {
        events.push({
          type: 'response_created',
          data: { responseId: chunk.response_id }
        });
      }

      // Usage event
      if (chunk.usage) {
        events.push({
          type: 'usage',
          data: {
            inputTokens: chunk.usage.input_tokens,
            outputTokens: chunk.usage.output_tokens
          }
        });
      }

      // Content delta
      if (chunk.choices?.[0]?.delta) {
        const delta = chunk.choices[0].delta;

        // Thinking summary phase
        if (delta.phase === 'thinking_summary') {
          if (delta.extra?.summary_thought?.content) {
            const thoughts = delta.extra.summary_thought.content;
            if (Array.isArray(thoughts) && thoughts.length > 0) {
              events.push({
                type: 'thinking',
                data: { thoughts, responseId: chunk.response_id }
              });
            }
          }
          continue;
        }

        // Answer phase / regular content
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (delta.content === 'FINISHED') {
            events.push({ type: 'done', data: null });
            continue;
          }

          // Check for embedded tool calls in content
          const toolCallMatch = delta.content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
          if (toolCallMatch) {
            try {
              const toolData = JSON.parse(toolCallMatch[1]);
              events.push({
                type: 'tool_call',
                data: {
                  name: toolData.name,
                  arguments: toolData.arguments || toolData.parameters || {},
                  responseId: chunk.response_id
                }
              });
            } catch {
              // Not valid JSON, treat as content
              events.push({
                type: 'content',
                data: { content: delta.content, responseId: chunk.response_id }
              });
            }
          } else {
            events.push({
              type: 'content',
              data: { content: delta.content, responseId: chunk.response_id }
            });
          }
        }

        // Direct tool_calls in delta (OpenAI-style)
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            events.push({
              type: 'tool_call',
              data: {
                index: tc.index,
                id: tc.id,
                name: tc.function?.name,
                arguments: tc.function?.arguments,
                responseId: chunk.response_id
              }
            });
          }
        }
      }
    } catch (err) {
      // Skip malformed chunks silently
    }
  }

  return events;
}

// Worker message handler
if (parentPort) {
  parentPort.on('message', (msg: WorkerMessage) => {
    if (msg.type !== 'parse') return;

    try {
      const events = parseSSEChunks(msg.chunks);
      const response: WorkerResponse = {
        type: 'result',
        id: msg.id,
        events
      };
      parentPort!.postMessage(response);
    } catch (err: any) {
      const response: WorkerResponse = {
        type: 'error',
        id: msg.id,
        error: err.message || 'Unknown worker error'
      };
      parentPort!.postMessage(response);
    }
  });

  // Signal ready
  parentPort.postMessage({ type: 'ready' });
}
