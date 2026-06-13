/**
 * File: chat/stream.ts
 * Project: qwenproxy
 * SSE streaming response handling
 */

import { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import { ReadableStream } from 'stream/web'
import crypto from 'crypto'
import { QwenStreamParser } from '../../utils/qwen-stream-parser.js'
import { StreamingToolParser } from '../../tools/parser.js'
import { getIncrementalDelta, DeltaResult } from './helpers.js'
import { parseQwenErrorPayload } from './helpers.js'
import { updateSessionParent } from '../../services/qwen.js'
import { removeStream } from '../../core/stream-registry.js'
import { metrics } from '../../core/metrics.js'
import { updateDecisionOutcome } from '../../core/model-router.js'
import { warmPoolManager } from '../../services/warm-pool.js'

export interface StreamDependencies {
  body: any;
  createQwenStream: Function;
  isThinkingModel: boolean;
  model: string;
  accountId: string | undefined;
  pendingMultimodal: any;
  useExistingChat: boolean;
  forcedChatId: string | undefined;
  hasTools: boolean;
  completionId: string;
  uiSessionId: string;
  acquiredLock: { release: () => void; accountId: string } | null;
  requestStartTime: number;
  tenant: any;
  finalPrompt: string;
  routerDecision: any;  // NEW: Phase 4 - Router decision for outcome tracking
}

export interface StreamResult {
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  controller: any;
  accountId: string;
  chatId: string;
}

/**
 * Handle non-streaming response
 */
export async function handleNonStreamingResponse(
  c: Context,
  deps: StreamDependencies
): Promise<Response> {
  const { createQwenStream, completionId, finalPrompt, hasTools, body, acquiredLock: acquiredLock_, requestStartTime, tenant } = deps;
  let acquiredLock = acquiredLock_;
  
  const result = await createQwenStream(
    finalPrompt,
    deps.isThinkingModel,
    deps.model,
    null,
    deps.accountId === 'global' ? undefined : deps.accountId,
    undefined,
    deps.pendingMultimodal.length > 0 ? deps.pendingMultimodal : undefined,
    deps.useExistingChat ? deps.forcedChatId : undefined
  );
  
  const reader = result.stream.getReader();
  const decoder = new TextDecoder();
  
  const toolCallsOut: any[] = [];
    let buffer = '';

    // Also use StreamingToolParser to catch tool calls in content (Qwen split JSON format)
    const streamingToolParser = hasTools ? new StreamingToolParser(body.tools) : null;

    const qwenParser = new QwenStreamParser(result.uiSessionId, {
      tools: hasTools ? body.tools : [],
      onThinking: (_content: string) => {},
      onAnswer: (content: string) => {
        if (streamingToolParser) {
          const { toolCalls } = streamingToolParser.feed(content);
          for (const tc of toolCalls) {
            toolCallsOut.push({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments)
              }
            });
          }
        }
      },
      onToolCall: (tc) => {
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        });
      },
    });
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      
      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') continue;
      
      qwenParser.parseLine(dataStr);
    }
  }
  
  const upstreamError = parseQwenErrorPayload(buffer);
  if (upstreamError) {
    removeStream(completionId);
    if (acquiredLock) acquiredLock.release();
    return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
  }
  
  const { text: remainingText, toolCalls: remainingToolCalls } = qwenParser.flush();
    const parserState = qwenParser.state;
    let finalContent = parserState.lastFullContent;
    if (remainingText) finalContent += remainingText;

    // Also flush streaming tool parser for any remaining tool calls in content
    if (streamingToolParser) {
      const { toolCalls: flushToolCalls } = streamingToolParser.flush();
      for (const tc of flushToolCalls) {
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        });
      }
    }

    // SIMPLE TOOL CALL EXTRACTION - Works with Qwen's malformed format
    if (hasTools && finalContent && toolCallsOut.length === 0) {
      // Unescape Qwen's double-escaped content
      let searchContent = finalContent
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      try {
        const parsed = JSON.parse(`"${searchContent}"`);
        searchContent = parsed;
      } catch {}

      const knownToolNames: Set<string> = new Set<string>(
        (body.tools?.filter((t: any) => t.type === 'function').map((t: any) => t.function.name) || []) as string[]
      );

      // Find each known tool name, then extract expression value nearby
      for (const toolName of knownToolNames) {
        if (toolCallsOut.some(tc => tc.function.name === toolName)) continue;

        const positions: number[] = [];
        let pos = searchContent.indexOf(toolName);
        while (pos >= 0) {
          positions.push(pos);
          pos = searchContent.indexOf(toolName, pos + 1);
        }

        // Also search in "name" field
        const nameFieldRegex = new RegExp(`"name"\\s*:\\s*"([^"]*${toolName}[^"]*)"`, 'g');
        let nameMatch;
        while ((nameMatch = nameFieldRegex.exec(searchContent)) !== null) {
          positions.push(nameMatch.index);
        }

        for (const toolPos of positions) {
          const searchWindow = 500;
          const start = Math.max(0, toolPos - 500);
          const end = Math.min(searchContent.length, toolPos + toolName.length + 500);
          const window = searchContent.substring(start, end);

          // Pattern: "expression": "VALUE" or "expression": {OBJECT}
          const exprRegex = /"expression"\s*:\s*(?:(\{[^}]+\})|"([^"]+)")/g;
          let exprMatch;
          while ((exprMatch = exprRegex.exec(window)) !== null) {
            const exprVal = exprMatch[1] || exprMatch[2];
            if (!exprVal) continue;

            let toolArgs: any = {};
            try { toolArgs = JSON.parse(exprVal); } catch { toolArgs = { expression: exprVal }; }

            if (Object.keys(toolArgs).length > 0) {
              toolCallsOut.push({
                id: `call_${crypto.randomUUID()}`,
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(toolArgs) }
              });
              break;
            }
          }
        }
      }
    }

    for (const tc of remainingToolCalls) {
    toolCallsOut.push({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
    });
  }
  
  const usage = {
    prompt_tokens: parserState.promptTokens,
    completion_tokens: parserState.completionTokens,
    total_tokens: parserState.promptTokens + parserState.completionTokens,
    prompt_tokens_details: { cached_tokens: 0 }
  };

  // Release warm pool chat back to pool
  if (deps.accountId && result.chatId && result.headers) {
    try {
      await warmPoolManager.release(deps.accountId, result.chatId, result.headers);
      console.log(`[Chat] Released chat ${result.chatId} back to warm pool for account ${deps.accountId}`);
    } catch (err: any) {
      console.warn('[Chat] Failed to release warm pool chat:', err.message);
    }
  }

  const hasThinking = !!parserState.reasoningBuffer;
  const hasToolCalls = toolCallsOut.length > 0;
  const hasContent = typeof finalContent === 'string' && finalContent.length > 0;
  const isEmptyResponse = !hasContent && !hasThinking && !hasToolCalls;
  
  if (isEmptyResponse) {
    removeStream(completionId);
    if (acquiredLock) acquiredLock.release();
    return c.json({ error: { message: 'Upstream returned empty response' } }, 502 as any);
  }
  
  const message: any = { role: 'assistant', content: hasToolCalls ? null : finalContent };
  if (hasThinking) message.reasoning_content = parserState.reasoningBuffer;
  if (hasToolCalls) {
    toolCallsOut.forEach((tc, idx) => tc.index = idx);
    message.tool_calls = toolCallsOut;
  }
  
  removeStream(completionId);
  
  // Store in semantic cache
  if (process.env.SEMANTIC_CACHE_ENABLED !== 'false' && hasToolCalls || finalContent) {
    try {
      const responseContent = hasToolCalls ? JSON.stringify(toolCallsOut) : finalContent;
      if (responseContent && responseContent.length > 20) {
        const { semanticCache } = require('../../cache/semantic-cache.js');
        semanticCache.store(finalPrompt, responseContent);
      }
    } catch (err: any) {
      console.warn('[Chat] Failed to store in semantic cache:', err.message);
    }
  }
  
  // Record tenant request
  if (tenant) {
    const { decrementStreams, recordRequest } = require('../../core/multi-tenant.js');
    decrementStreams(tenant.id);
    recordRequest({
      tenantId: tenant.id,
      requestId: completionId,
      model: body.model,
      tokens: usage.total_tokens,
      latencyMs: Date.now() - requestStartTime,
      timestamp: Date.now(),
      success: !isEmptyResponse,
    });
  }
  
  // Release account lock
  if (acquiredLock) {
    acquiredLock.release();
    acquiredLock = null;
  }
  
  // NEW: Phase 4 - Record router decision outcome
  if (deps.routerDecision) {
    const latencyMs = Date.now() - requestStartTime;
    const success = !isEmptyResponse;
    updateDecisionOutcome(deps.routerDecision.timestamp, latencyMs, success, deps.model);
    console.log(`[Chat] Router outcome: model=${deps.model}, latency=${latencyMs}ms, success=${success}, reason=${deps.routerDecision.reason}`);
  }

  return c.json({
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: hasToolCalls ? 'tool_calls' : 'stop'
    }],
    usage
  });
}

/**
 * Handle streaming response
 */
export async function handleStreamingResponse(
  c: Context,
  deps: StreamDependencies
): Promise<Response> {
  const { createQwenStream, completionId, finalPrompt, hasTools, body, acquiredLock, requestStartTime, tenant } = deps;
  
  // First create the stream
  const result = await createQwenStream(
    finalPrompt,
    deps.isThinkingModel,
    deps.model,
    null,
    deps.accountId === 'global' ? undefined : deps.accountId,
    undefined,
    deps.pendingMultimodal.length > 0 ? deps.pendingMultimodal : undefined,
    deps.useExistingChat ? deps.forcedChatId : undefined
  );
  
  // Disable Nagle's algorithm
  const socket = (c.env as any)?.incoming?.socket || (c.req.raw as any).socket;
  if (socket && typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true);
  }
  
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  
  const streamingLock = acquiredLock;
  
  return honoStream(c, async (streamWriter: any) => {
    let heartbeatInterval: any;
    try {
      // Send heartbeat to prevent Cloudflare 524 timeout
      await streamWriter.write(': heartbeat\n\n');
      
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch (e) {
          clearInterval(heartbeatInterval);
        }
      }, 15000);
      
      const writeEvent = (data: any) => {
        streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      
      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });
      
      const createdTimestamp = Math.floor(Date.now() / 1000);
      
      const fastWriteContent = (content: string) => {
        const escaped = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        streamWriter.write(`data: {"id":"${completionId}","object":"chat.completion.chunk","created":${createdTimestamp},"model":"${body.model}","choices":[{"index":0,"delta":{"content":"${escaped}"},"logprobs":null,"finish_reason":null}]}\n\n`);
      };
      
      const fastWriteReasoning = (content: string) => {
        const escaped = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        streamWriter.write(`data: {"id":"${completionId}","object":"chat.completion.chunk","created":${createdTimestamp},"model":"${body.model}","choices":[{"index":0,"delta":{"reasoning_content":"${escaped}"},"logprobs":null,"finish_reason":null}]}\n\n`);
      };
      
      writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: body.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });
      
      const reader = result.stream.getReader();
      const decoder = new TextDecoder();
      
      let reasoningBuffer = '';
      let lastFullContent = '';
      let contentLength = 0;
      let contentSuffix = '';
      let targetResponseId: string | null = null;
      let targetResponseIdSet = false;
      let currentThoughtIndex = 0;
      const toolParser = hasTools ? new StreamingToolParser(body.tools) : null;
      const bufferChunks: string[] = [];
      let bufferOffset = 0;
      let cachedBuffer: string | null = null;
      let cachedBufferValid = false;
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);
      
      const getBuffer = (): string => {
        if (!cachedBufferValid) {
          cachedBuffer = bufferChunks.join('');
          cachedBufferValid = true;
        }
        return cachedBuffer!;
      };
      
      const invalidateCache = () => {
        cachedBufferValid = false;
      };
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const decodedChunk = decoder.decode(value, { stream: true });
        bufferChunks.push(decodedChunk);
        invalidateCache();
        
        const buffer = getBuffer();
        
        while (bufferOffset < buffer.length) {
          const newlineIdx = buffer.indexOf('\n', bufferOffset);
          if (newlineIdx === -1) break;
          
          const line = buffer.slice(bufferOffset, newlineIdx);
          bufferOffset = newlineIdx + 1;
          
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            streamWriter.write('data: [DONE]\n\n');
            continue;
          }
          
          try {
            const chunk = JSON.parse(dataStr);
            
            // Extract response_id for session tracking
            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
                targetResponseIdSet = true;
              }
              updateSessionParent(result.uiSessionId, chunk['response.created'].response_id);
            } else if (chunk.response_id && !targetResponseIdSet) {
              targetResponseId = chunk.response_id;
              targetResponseIdSet = true;
              updateSessionParent(result.uiSessionId, chunk.response_id);
            }
            
            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }
            
            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;
            
            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
                (!targetResponseIdSet || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;
              
              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  if (thoughts.length > currentThoughtIndex) {
                    vStr = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    foundStr = true;
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || '';
                  const deltaResult: DeltaResult = getIncrementalDelta(lastFullContent, newContent, contentLength, contentSuffix);
                  vStr = deltaResult.delta;
                  if (vStr) {
                    lastFullContent = deltaResult.matchedContent;
                    contentLength = deltaResult.contentLength;
                    contentSuffix = deltaResult.contentSuffix;
                    foundStr = true;
                  }
                }
              }
            }
            
            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;
              
              if (isThinkingChunk) {
                reasoningBuffer += vStr;
                fastWriteReasoning(vStr);
              } else {
                if (hasTools && toolParser) {
                  const { text, toolCalls } = toolParser.feed(vStr);
                  if (text) {
                    fastWriteContent(text);
                  }
                  for (const tc of toolCalls) {
                    streamWriter.write(`data: ${JSON.stringify({
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: createdTimestamp,
                      model: body.model,
                      choices: [makeChoice({
                        tool_calls: [{
                          index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                          id: tc.id,
                          type: 'function',
                          function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments)
                          }
                        }]
                      })]
                    })}\n\n`);
                  }
                } else {
                  if (vStr) {
                    fastWriteContent(vStr);
                  }
                }
              }
            }
          } catch (e) {
            if (dataStr.length > 10) {
              console.warn(`[Chat] SSE parse error for chunk (${dataStr.length} chars):`, (e as Error).message);
            }
          }
        }
        
        if (bufferOffset > 0) {
          if (bufferOffset >= buffer.length) {
            bufferChunks.length = 0;
            bufferOffset = 0;
          } else {
            const remaining = buffer.slice(bufferOffset);
            bufferChunks.length = 0;
            bufferChunks.push(remaining);
            bufferOffset = 0;
          }
          invalidateCache();
        }
      }
      
      const finalBuffer = getBuffer();
      const upstreamError = parseQwenErrorPayload(finalBuffer);
      if (upstreamError) {
        writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: body.model,
          choices: [makeChoice({ content: upstreamError.message })]
        });
        writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: body.model,
          choices: [makeChoice({}, 'stop')]
        });
        streamWriter.write('data: [DONE]\n\n');
        return;
      }
      
      if (toolParser) {
        const flushResult = toolParser.flush();
        
        if (flushResult.text) {
          writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTimestamp,
            model: body.model,
            choices: [makeChoice({ content: flushResult.text })]
          });
        }
        for (const tc of flushResult.toolCalls) {
          const idx = toolParser.getEmittedToolCallCount() - flushResult.toolCalls.length + flushResult.toolCalls.indexOf(tc);
          writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTimestamp,
            model: body.model,
            choices: [makeChoice({
              tool_calls: [{
                index: idx,
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments)
                }
              }]
            })]
          });
        }
      }
      
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
      
      const finalFinishReason = toolParser && toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';
      
      writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        ...(body.stream_options?.include_usage ? {} : { usage })
      });
      
      if (body.stream_options?.include_usage) {
        writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: body.model,
          choices: [],
          usage
        });
      }
      streamWriter.write('data: [DONE]\n\n');
      
    } catch (streamErr) {
      throw streamErr;
    } finally {
      clearInterval(heartbeatInterval);
      removeStream(completionId);
      
      // Release warm pool chat back to pool
      if (deps.accountId && result.chatId && result.headers) {
        try {
          await warmPoolManager.release(deps.accountId, result.chatId, result.headers);
          console.log(`[Chat] Released chat ${result.chatId} back to warm pool for account ${deps.accountId}`);
        } catch (err: any) {
          console.warn('[Chat] Failed to release warm pool chat:', err.message);
        }
      }

      if (streamingLock) {
        streamingLock.release();
      }
      // NEW: Phase 4 - Record router decision outcome for streaming
      if (deps.routerDecision) {
        const latencyMs = Date.now() - deps.requestStartTime;
        // For streaming, consider it successful if we reached [DONE] without error
        const success = true; // Could be refined based on streamErr
        updateDecisionOutcome(deps.routerDecision.timestamp, latencyMs, success, deps.model);
        console.log(`[Chat] Router outcome (streaming): model=${deps.model}, latency=${latencyMs}ms, success=${success}, reason=${deps.routerDecision.reason}`);
      }
    }
  });
}