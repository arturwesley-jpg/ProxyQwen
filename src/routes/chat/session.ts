/**
 * File: chat/session.ts
 * Project: qwenproxy
 * Session management + conversation_id handling
 */

import { Message } from '../../utils/types.js';
import { getSession, createSession, updateSession } from '../../core/session-manager.js';
import { countTokens } from '../../utils/token-estimation.js';
import { getModelContextWindow } from '../../core/model-registry.js';
import { truncateMessages } from '../../utils/context-truncation.js';
import { needsSummarization, summarizeConversation } from '../../utils/context-summarizer.js';
import { semanticCache } from '../../cache/semantic-cache.js';
import { metrics } from '../../core/metrics.js';
import crypto from 'crypto';

export interface SessionContext {
  conversationId: string;
  existingSession: ReturnType<typeof getSession> | null;
  useExistingChat: boolean;
  forcedChatId: string | undefined;
  forcedAccountId: string | undefined;
  isNewSession: boolean;
}

/**
 * Resolve conversation ID from request
 */
export function resolveConversationId(
  body: any, 
  messages: Message[], 
  requestedAccountId: string | undefined
): string {
  const accountSuffix = requestedAccountId ? `:${requestedAccountId}` : '';
  
  return (body as any).conversation_id || 
    (body as any).metadata?.conversation_id ||
    (() => {
      const firstMsgs = messages.slice(0, 3).map(m => {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${m.role}:${c.slice(0, 100)}`;
      }).join('|');
      return 'auto-' + crypto.createHash('md5').update(firstMsgs + accountSuffix).digest('hex').slice(0, 16);
    })();
}

/**
 * Initialize session context
 */
export function initSessionContext(
  conversationId: string,
  messages: Message[]
): SessionContext {
  const existingSession = getSession(conversationId);
  const isNewSession = !messages.some(m => m.role === 'assistant');
  
  return {
    conversationId,
    existingSession,
    useExistingChat: !!existingSession,
    forcedChatId: existingSession?.qwenChatId,
    forcedAccountId: existingSession?.accountId,
    isNewSession,
  };
}

/**
 * Apply context truncation if needed
 */
export function applyContextTruncation(
  messages: Message[],
  systemPrompt: string,
  modelId: string,
  body: any
): { finalPrompt: string; truncatedBody: Message[] } {
  const modelContextWindow = getModelContextWindow(modelId);
  const estimatedTokens = countTokens(systemPrompt + messages.map(m => JSON.stringify(m)).join(''), modelId);
  
  let finalPrompt: string;
  let messagesForRequest = messages;
  
  if (estimatedTokens > modelContextWindow - 1000) {
    const truncated = truncateMessages(messages, modelContextWindow, systemPrompt, modelId);
    const truncatedBody = truncated.map(m => ({
      ...m,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }));
    finalPrompt = systemPrompt ? `${systemPrompt}\n\n${truncatedBody.map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`).join('\n\n')}` : truncatedBody.map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`).join('\n\n');
    return { finalPrompt, truncatedBody: messagesForRequest };
  } else {
    finalPrompt = systemPrompt ? `${systemPrompt}\n${messages.map(m => m.role === 'user' ? `User: ${typeof m.content === 'string' ? m.content : ''}` : m.role === 'assistant' ? `Assistant: ${typeof m.content === 'string' ? m.content : ''}` : '').join('\n\n')}` : messages.map(m => m.role === 'user' ? `User: ${typeof m.content === 'string' ? m.content : ''}` : m.role === 'assistant' ? `Assistant: ${typeof m.content === 'string' ? m.content : ''}` : '').join('\n\n');
  }
  
  return { finalPrompt, truncatedBody: messagesForRequest };
}

/**
 * Apply context summarization if enabled and needed
 */
export async function applySummarization(
  sessionCtx: SessionContext,
  messages: Message[],
  modelId: string
): Promise<Message[]> {
  if (process.env.SUMMARIZER_ENABLED === 'false') return messages;
  
  const plainMessages = messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  }));
  
  if (needsSummarization(plainMessages, modelId)) {
    try {
      const summaryResult = await summarizeConversation(sessionCtx.conversationId, plainMessages, modelId);
      if (summaryResult) {
        metrics.increment('summarizer.triggered');
        metrics.histogram('summarizer.tokens_saved', summaryResult.tokensSaved);
        console.log(`[Chat] Context summarized: saved ${summaryResult.tokensSaved} tokens`);
        return summaryResult.summarizedMessages as any;
      }
    } catch (err: any) {
      console.warn('[Chat] Summarization failed, using original messages:', err.message);
    }
  }
  
  return messages;
}

/**
 * Check semantic cache for non-streaming requests
 */
export function checkSemanticCache(prompt: string, isStream: boolean): any | null {
  console.log('[Session] checkSemanticCache called, isStream:', isStream, 'prompt:', prompt.slice(0, 50));
  if (isStream || process.env.SEMANTIC_CACHE_ENABLED === 'false') {
    console.log('[Session] checkSemanticCache returning null (stream or disabled)');
    return null;
  }
  
  const cacheHit = semanticCache.lookup(prompt);
  if (cacheHit) {
    console.log('[Session] checkSemanticCache returning HIT:', cacheHit.hash.slice(0, 8));
    return cacheHit;
  }
  
  console.log('[Session] checkSemanticCache returning MISS');
  return null;
}

/**
 * Store successful response in semantic cache
 */
export function storeInSemanticCache(prompt: string, responseContent: string): void {
  if (process.env.SEMANTIC_CACHE_ENABLED === 'false') return;
  if (!responseContent || responseContent.length <= 20) return;
  
  try {
    semanticCache.store(prompt, responseContent);
  } catch (err: any) {
    console.warn('[Chat] Failed to store in semantic cache:', err.message);
  }
}

/**
 * Update session after successful stream creation
 */
export function updateSessionAfterStream(
  sessionCtx: SessionContext,
  uiSessionId: string,
  accountId: string
): void {
  if (sessionCtx.existingSession) {
    updateSession(sessionCtx.conversationId, uiSessionId);
  } else {
    createSession(sessionCtx.conversationId, uiSessionId, accountId, null);
  }
}