/**
 * File: chat/parser.ts
 * Project: qwenproxy
 * Request body parsing + chunked encoding handling
 */

import { Context } from 'hono';
import { OpenAIRequest } from '../../utils/types.js';

/**
 * Parse request body with chunked encoding handling
 * Hono doesn't always parse chunked encoding correctly in Node.js
 */
export async function parseRequestBody(c: Context): Promise<OpenAIRequest> {
  const rawBody = await c.req.text();
  
  // Handle chunked encoding: "1925{json}" or "1925\r\n{json}\r\n0\r\n\r\n"
  let body: OpenAIRequest;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    const chunkedMatch = rawBody.match(/^([0-9a-fA-F]+)(?:\r?\n)?(.*)/s);
    if (chunkedMatch) {
      const hexSize = parseInt(chunkedMatch[1], 16);
      const decSize = parseInt(chunkedMatch[1], 10);
      let chunkData = chunkedMatch[2];
      chunkData = chunkData.replace(/\r?\n0\r?\n\r?\n?$/, '');
      
      let chunkSize = hexSize;
      if (chunkData.length !== hexSize && chunkData.length === decSize) {
        chunkSize = decSize;
      } else if (chunkData.length === hexSize || chunkData.length === hexSize + 2) {
        // hexSize matches
      }
      
      if (chunkData.length === chunkSize || chunkData.length === chunkSize + 2) {
        body = JSON.parse(chunkData);
      } else {
        throw new Error(`Chunk size mismatch: expected ${chunkSize}, got ${chunkData.length}`);
      }
    } else {
      throw e;
    }
  }
  
  return body;
}