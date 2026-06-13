/**
 * File: chat/index.ts
 * Project: qwenproxy
 * Main chat completions handler - orchestrates all modules
 */

import { Context } from 'hono';
import crypto from 'crypto';
import { createQwenStream, updateSessionParent, RetryableQwenStreamError } from '../../services/qwen.js';
import { OpenAIRequest, Message } from '../../utils/types.js';
import { robustParseJSON } from '../../utils/json.js';
import { StreamingToolParser } from '../../tools/parser.js';
import { QwenStreamParser } from '../../utils/qwen-stream-parser.js';
import { getModelContextWindow } from '../../core/model-registry.js'
import { truncateMessages, estimateTokenCount } from '../../utils/context-truncation.js';
import { registerStream, removeStream } from '../../core/stream-registry.js';
import { metrics } from '../../core/metrics.js'
import { semanticCache } from '../../cache/semantic-cache.js';
import { countTokens } from '../../utils/token-estimation.js';
import { extractFeatures, routeModel } from '../../core/model-router.js';
import { needsSummarization, summarizeConversation } from '../../utils/context-summarizer.js';
import { startTrace, endTrace, addTag, log as traceLog } from '../../core/opentelemetry.js';
import { acquireAccountLock, getLockInfo, isAccountLocked } from '../../core/account-lock.js';

// Import new modular components
import { parseRequestBody } from './parser.js';
import { mapRequestTools, mapToolChoice, mapResponseToolCalls } from './tool-mapper.js';
import { authenticateRequest, checkRateLimit, checkModelAllowed, trackStreamStart, trackStreamEnd, incrementRequestMetrics, recordRequestLatency } from './auth.js';
import { resolveConversationId, initSessionContext, applyContextTruncation, applySummarization, checkSemanticCache, storeInSemanticCache, updateSessionAfterStream } from './session.js';
import { handleNonStreamingResponse, handleStreamingResponse } from './stream.js';
import { selectAccountAndCreateStream } from './account-selector.js';
import { chatCompletionsStop } from './stop.js';
import { extractPrompt, generateConversationId, buildToolCallReinforcement, countToolCallsInMessages, getIncrementalDelta, parseQwenErrorPayload, DeltaResult } from './helpers.js';

// Re-export for backwards compatibility
export { chatCompletionsStop } from './stop.js';
export { getIncrementalDelta, parseQwenErrorPayload } from './helpers.js';
export type { DeltaResult } from './helpers.js';

const MAX_TOOL_CALLS_PER_SEGMENT = 4;

async function callQwenAndGetFullResponse(
  prompt: string,
  isThinkingModel: boolean,
  model: string,
  accountId?: string,
  chatId?: string,
  systemPrompt?: string  // NEW: Optional system prompt
): Promise<{ content: string; tool_calls?: any[]; reasoning_content?: string }> {
  const result = await createQwenStream(
    prompt,
    isThinkingModel,
    model,
    null,
    accountId,
    undefined,
    undefined,
    chatId,
    systemPrompt  // NEW
  );
  
  let fullContent = '';
  let reasoningContent = '';
  let toolCalls: any[] = [];
  const reader = result.stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  try {
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
        
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.choices?.[0]?.delta) {
            const delta = parsed.choices[0].delta;
            if (delta.content) {
              fullContent += delta.content;
            }
            if (delta.reasoning_content) {
              reasoningContent += delta.reasoning_content;
            }
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name && tc.function?.arguments) {
                  toolCalls.push({
                    id: tc.id || `tc-${Date.now()}-${toolCalls.length}`,
                    type: 'function',
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments
                    }
                  });
                }
              }
            }
          }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
  
  return { 
    content: fullContent, 
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    reasoning_content: reasoningContent || undefined
  };
}

export async function chatCompletions(c: Context) {
  // Request tracking
  incrementRequestMetrics();
  const requestStartTime = Date.now();
  const requestId = crypto.randomUUID();
  
  // Parse request body with chunked encoding handling
  let body: OpenAIRequest;
  try {
    body = await parseRequestBody(c);
  } catch (e: any) {
    return c.json({ error: { message: `Invalid request body: ${e.message}` } }, 400);
  }
  
  const isStream = body.stream ?? false;
  
  try {
    // Map tools from OpenClaude names to proxy names
    const bodyAny = body as any;
    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      bodyAny.tools = mapRequestTools(bodyAny.tools);
    }
    if (bodyAny.tool_choice) {
      bodyAny.tool_choice = mapToolChoice(bodyAny.tool_choice);
    }
    
    // Multi-tenant auth
    const authResult = await authenticateRequest(c);
    if (authResult.errorResponse) return authResult.errorResponse;
    const tenant = authResult.tenant;
    
    const rateLimit = checkRateLimit(tenant);
    if (!rateLimit.allowed) {
      return c.json({ error: rateLimit.reason }, 429);
    }
    
    if (!checkModelAllowed(tenant, body.model)) {
      return c.json({ error: `Model ${body.model} not allowed for this tenant` }, 403);
    }
    
    trackStreamStart(tenant);
    
    // S1: X-Account-Id header for multi-agent pinning
    const requestedAccountId = c.req.header('X-Account-Id') || c.req.header('x-account-id') || undefined;
    const agentId = c.req.header('X-Agent-Id') || c.req.header('x-agent-id') || 'default';
    
    if (requestedAccountId) {
      console.log(`[Chat] X-Account-Id pinned: ${requestedAccountId} (agent=${agentId})`);
    }
    
    // Extract prompt from messages
    let { prompt, systemPrompt, pendingMultimodal } = extractPrompt(body.messages || []);
    
    // Inject tools into system prompt
    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);
      
      const forcedTool = bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function
        ? bodyAny.tool_choice.function.name
        : undefined;
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n` + buildToolCallReinforcement(true, forcedTool);
    }
    
    const modelId = body.model.replace('-no-thinking', '');
    const modelContextWindow = getModelContextWindow(modelId);
    const estimatedTokens = countTokens(systemPrompt + prompt, modelId);
    const hasTools = Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0;

    // NEW: Phase 4 - Model Router with real metrics
    // Extract features for routing decision
    const toolCallCount = countToolCallsInMessages(body.messages || []);
    const features = extractFeatures(prompt, toolCallCount, pendingMultimodal.length > 0);
    const clientModel = body.model; // Preserve client's choice including -no-thinking
    const routerDecision = routeModel(features, clientModel);
    
    // Map back to the appropriate -no-thinking variant if client requested it
    let routedModel = routerDecision.chosenModel;
    if (clientModel.includes('-no-thinking') && !routedModel.includes('-no-thinking')) {
      routedModel = routedModel + '-no-thinking';
    }
    
    console.log(`[Chat] Model routing: ${clientModel} -> ${routedModel} (reason: ${routerDecision.reason}, confidence: ${routerDecision.confidence.toFixed(2)})`);

    // Apply context truncation
    const { finalPrompt, truncatedBody } = applyContextTruncation(
      body.messages || [],
      systemPrompt,
      modelId,
      body
    );
    
    // Check if auto-split needed
    const totalToolCallsInHistory = countToolCallsInMessages(body.messages || []);
    const needsAutoSplit = totalToolCallsInHistory > MAX_TOOL_CALLS_PER_SEGMENT;
    
    if (needsAutoSplit) {
      console.log(`[Chat] Auto-split triggered: ${totalToolCallsInHistory} tool calls in history (threshold: ${MAX_TOOL_CALLS_PER_SEGMENT})`);
    }
    
    // Session management
    const conversationId = resolveConversationId(body, body.messages || [], requestedAccountId);
    const sessionCtx = initSessionContext(conversationId, body.messages || []);
    
    // Summarization
    const summarizedMessages = await applySummarization(sessionCtx, body.messages || [], modelId);
    
    const isThinkingModel = !body.model.includes('no-thinking');
    const isNewSession = !summarizedMessages.some(m => m.role === 'assistant');

    // Check semantic cache for non-streaming requests
    let cachedResponse: any = null;
    if (!isStream && process.env.SEMANTIC_CACHE_ENABLED !== 'false') {
      console.log('[Chat Index] Checking semantic cache for prompt:', prompt.slice(0, 50));
      cachedResponse = checkSemanticCache(prompt, isStream);
      console.log('[Chat Index] Cache check result:', cachedResponse ? 'HIT' : 'MISS');
      if (cachedResponse) {
        console.log('[Chat Index] Returning cached response');
        const usage = {
          prompt_tokens: 0,
          completion_tokens: cachedResponse.response.length,
          total_tokens: cachedResponse.response.length,
          prompt_tokens_details: { cached_tokens: 0 }
        };
        const message: any = { role: 'assistant', content: cachedResponse.response };
        return c.json({
          id: 'chatcmpl-' + crypto.randomUUID(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{
            index: 0,
            message,
            logprobs: null,
            finish_reason: 'stop'
          }],
          usage
        });
      }
    }

    // Create stream dependencies
    const streamDeps = {
      body: bodyAny,
      createQwenStream,
      isThinkingModel,
      model: routedModel,  // Use routed model instead of body.model
      accountId: '', // Will be set by account selector
      pendingMultimodal,
      useExistingChat: sessionCtx.useExistingChat,
      forcedChatId: sessionCtx.forcedChatId,
      hasTools,
      completionId: 'chatcmpl-' + crypto.randomUUID(),
      uiSessionId: '',
      acquiredLock: null,
      requestStartTime,
      tenant,
      finalPrompt,
      routerDecision,  // Pass router decision for outcome recording
    };
    
    // Select account and create stream
    const accountResult = await selectAccountAndCreateStream(
      async (prompt: string, thinking: boolean, mdl: string, parentId: string | null, accId: string | undefined, files: any, multimodal: any, existingChatId: string | undefined, sysPrompt?: string) => {
        return createQwenStream(
          prompt, thinking, mdl, parentId, accId, files, multimodal, existingChatId, sysPrompt
        );
      },
      {
        finalPrompt,
        systemPrompt,  // NEW: Pass system prompt separately
        isThinkingModel,
        model: routedModel,  // Use routed model
        accountId: undefined,
        pendingMultimodal,
        useExistingChat: sessionCtx.useExistingChat,
        forcedChatId: sessionCtx.forcedChatId,
        forcedAccountId: sessionCtx.forcedAccountId,
        requestedAccountId,
        agentId,
        requestId,
      }
    );
    
    if (!accountResult) {
      return c.json({ error: 'All accounts exhausted' }, 429);
    }
    
    // Update session
    updateSessionAfterStream(sessionCtx, accountResult.uiSessionId, accountResult.accountUsed?.id || '');
    
    // Handle response based on streaming mode
    if (isStream) {
      return handleStreamingResponse(c, {
        ...streamDeps,
        accountId: accountResult.accountUsed?.id,
        uiSessionId: accountResult.uiSessionId,
        acquiredLock: accountResult.acquiredLock,
      });
    } else {
      return handleNonStreamingResponse(c, {
        ...streamDeps,
        accountId: accountResult.accountUsed?.id,
        uiSessionId: accountResult.uiSessionId,
        acquiredLock: accountResult.acquiredLock,
      });
    }
    
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    const status = err.upstreamStatus || 500;
    if (status >= 500) {
      metrics.increment('requests.errors');
    }
    return c.json({ error: { message: err.message } }, status);
  }
}