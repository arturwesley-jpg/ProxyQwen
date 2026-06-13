/**
 * File: chat/helpers.ts
 * Project: qwenproxy
 * Helper functions for chat route - pure utilities, no side effects
 */

import { Message } from '../../utils/types.js';
import crypto from 'crypto';

/**
 * Count tool calls in message history
 */
export function countToolCallsInMessages(messages: Message[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      count += msg.tool_calls.length;
    }
  }
  return count;
}

export interface MessageSegment {
  systemPrompt: string;
  messages: Message[];
}

/**
 * Split messages by tool call limit for auto-split feature
 */
export function splitMessagesByToolCallLimit(
  messages: Message[],
  maxToolCalls: number
): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let currentSegment: Message[] = [];
  let currentToolCallCount = 0;

  const systemMessages: Message[] = [];
  const nonSystemMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessages.push(msg);
    } else {
      nonSystemMessages.push(msg);
    }
  }

  const systemPromptText = systemMessages.map(m => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('\n');
    }
    return JSON.stringify(m.content);
  }).join('\n\n');

  for (const msg of nonSystemMessages) {
    const toolCallsInMsg = msg.role === 'assistant' && msg.tool_calls
      ? msg.tool_calls.length
      : 0;

    if (currentToolCallCount + toolCallsInMsg > maxToolCalls && currentSegment.length > 0) {
      segments.push({
        systemPrompt: systemPromptText,
        messages: [...currentSegment]
      });
      currentSegment = [msg];
      currentToolCallCount = toolCallsInMsg;
    } else {
      currentSegment.push(msg);
      currentToolCallCount += toolCallsInMsg;
    }
  }

  if (currentSegment.length > 0) {
    segments.push({
      systemPrompt: systemPromptText,
      messages: [...currentSegment]
    });
  }

  return segments;
}

/**
 * Incremental delta calculation for streaming - O(1) fast path
 */
export interface DeltaResult {
  delta: string;
  matchedContent: string;
  contentLength: number;
  contentSuffix: string;
}

export function getIncrementalDelta(
  oldStr: string, 
  newStr: string, 
  prevLength: number = 0, 
  prevSuffix: string = ''
): DeltaResult {
  if (!oldStr) {
    return { 
      delta: newStr, 
      matchedContent: newStr,
      contentLength: newStr.length,
      contentSuffix: newStr.slice(-64)
    };
  }
  if (newStr === oldStr) {
    return { delta: '', matchedContent: oldStr, contentLength: prevLength, contentSuffix: prevSuffix };
  }

  // Ultra-fast path: use length tracking to avoid O(n) startsWith on large strings
  if (newStr.length > prevLength && prevLength > 0) {
    const delta = newStr.slice(prevLength);
    const checkLen = Math.min(64, prevLength);
    const expectedSuffix = prevSuffix.slice(-checkLen);
    const actualSuffix = newStr.slice(prevLength - checkLen, prevLength);
    
    if (expectedSuffix === actualSuffix) {
      return { 
        delta, 
        matchedContent: newStr,
        contentLength: newStr.length,
        contentSuffix: newStr.slice(-64)
      };
    }
  }

  // Fallback: startsWith check for edge cases
  if (newStr.startsWith(oldStr)) {
    const delta = newStr.slice(oldStr.length);
    return { 
      delta, 
      matchedContent: newStr,
      contentLength: newStr.length,
      contentSuffix: newStr.slice(-64)
    };
  }

  // Segment-based prefix matching (rare path)
  const scanWindow = Math.min(2000, oldStr.length);
  const maxLen = Math.min(scanWindow, newStr.length);

  let commonPrefixLen = 0;
  const segmentLen = 64;
  while (commonPrefixLen + segmentLen <= maxLen) {
    if (oldStr.slice(commonPrefixLen, commonPrefixLen + segmentLen) !==
        newStr.slice(commonPrefixLen, commonPrefixLen + segmentLen)) {
      break;
    }
    commonPrefixLen += segmentLen;
  }

  while (commonPrefixLen < maxLen && oldStr[commonPrefixLen] === newStr[commonPrefixLen]) {
    commonPrefixLen++;
  }

  const threshold = Math.min(scanWindow, 4);
  if (commonPrefixLen >= threshold) {
    return { 
      delta: newStr.substring(commonPrefixLen), 
      matchedContent: newStr,
      contentLength: newStr.length,
      contentSuffix: newStr.slice(-64)
    };
  }

  const combined = oldStr + newStr;
  return { 
    delta: newStr, 
    matchedContent: combined,
    contentLength: combined.length,
    contentSuffix: combined.slice(-64)
  };
}

/**
 * Parse Qwen error payload from upstream
 */
export function parseQwenErrorPayload(raw: string): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith('data: ')) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || 'Qwen returned an error';
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
      const status = code === 'RateLimited' ? 429 : (code === 'Not_Found' ? 404 : 502);
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : (payload.error.message || JSON.stringify(payload.error));
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    return { message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`, status: 502 };
  }

  return null;
}

/**
 * Extract prompt from messages, handling multimodal content
 */
export interface ExtractedPrompt {
  prompt: string;
  systemPrompt: string;
  pendingMultimodal: Array<Array<{ 
    type: string; 
    text?: string; 
    image_url?: { url: string }; 
    video_url?: { url: string }; 
    audio_url?: { url: string }; 
    file_url?: { url: string } 
  }>>;
}

export function extractPrompt(messages: Message[]): ExtractedPrompt {
  let prompt = '';
  let systemPrompt = '';
  const pendingMultimodal: ExtractedPrompt['pendingMultimodal'] = [];

  for (const msg of messages) {
    let contentStr = '';
    if (Array.isArray(msg.content)) {
      // Single-pass: extract text and multimodal parts in one iteration
      const textParts: string[] = [];
      const multimodalParts: Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }> = [];
      
      for (const p of msg.content as any[]) {
        if (p.type === "text" && p.text) {
          textParts.push(p.text);
        } else if (
          (p.type === "image_url" && p.image_url?.url) ||
          (p.type === "video_url" && p.video_url?.url) ||
          (p.type === "audio_url" && p.audio_url?.url) ||
          (p.type === "file_url" && p.file_url?.url)
        ) {
          multimodalParts.push(p);
        }
      }
      
      contentStr = textParts.join("\n");
      if (multimodalParts.length > 0) {
        pendingMultimodal.push(multimodalParts);
      }
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || '';
    }

    if (msg.role === 'system') {
      systemPrompt += (contentStr || '') + '\n\n';
    } else if (msg.role === 'user') {
      prompt += `User: ${contentStr || ''}\n\n`;
    } else if (msg.role === 'assistant') {
      let assistantContent = contentStr || '';
      const reasoning = (msg as any).reasoning_content;
      if (reasoning) {
        assistantContent = `Thinking\n${reasoning}\n\n${assistantContent}`;
      }
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const args = tc.function?.arguments;
          let parsedArgs: any = {};
          if (typeof args === 'string') {
            try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
          } else if (args && typeof args === 'object') {
            parsedArgs = args;
          }
          const payload = { name: tc.function?.name, arguments: parsedArgs };
          const toolCallStr = `\n
{"name": "${payload.name}", "arguments": ${JSON.stringify(payload.arguments)}}`;
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      }
    } else if (msg.role === 'tool' || msg.role === 'function') {
      let toolName = (msg as any).name;
      if (!toolName && (msg as any).tool_call_id) {
        // Look up tool name in history by tool_call_id
        for (let j = messages.indexOf(msg) - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
            const call = prevMsg.tool_calls.find(tc => tc.id === (msg as any).tool_call_id);
            if (call) {
              toolName = call.function?.name;
              break;
            }
          }
        }
      }
      prompt += `Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n\n`;
    }
  }

  return { prompt, systemPrompt, pendingMultimodal };
}

/**
 * Generate conversation ID from first messages
 */
export function generateConversationId(messages: Message[], accountSuffix: string): string {
  const firstMsgs = messages.slice(0, 3).map(m => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `${m.role}:${c.slice(0, 100)}`;
  }).join('|');
  return 'auto-' + crypto.createHash('md5').update(firstMsgs + accountSuffix).digest('hex').slice(0, 16);
}

/**
 * Build tool calling format reinforcement for system prompt
 */
export function buildToolCallReinforcement(hasTools: boolean, forcedTool?: string): string {
  if (!hasTools) return '';
  
  return `
=== CRITICAL TOOL CALL FORMAT (MANDATORY) ===
When you need to call a tool, you MUST output EXACTLY this format:


{"name": "tool_name", "arguments": {"param": "value"}}

=== FORBIDDEN (NEVER DO THESE) ===
WRONG:  {"name":"terminal"}
{"command":"ls"}
WRONG:  {"name":"read_file","path":"file.txt"}
WRONG:  {"name":"X"}
{"key":"value"}

=== RULES ===
1. ONE JSON object with "name" AND "arguments" fields
2. "arguments" MUST be an object with the tool parameters
3. NEVER split across multiple JSON objects
4. NEVER use "path", "command" etc. at top level - they go INSIDE "arguments"
${forcedTool ? `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n` : ''}`;
}