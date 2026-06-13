/**
 * File: chat/account-selector.ts
 * Project: qwenproxy
 * Account selection with locking (S1 + S2 multi-agent support)
 */

import { getNextAccount, getNextAvailableAccount, getNextUnlockedAccount, getAccountCooldownInfo, markAccountRateLimited } from '../../core/account-manager.js';
import { getAccountCredentials } from '../../core/accounts.js';
import { acquireAccountLock, getLockInfo } from '../../core/account-lock.js';
import { RetryableQwenStreamError } from '../../services/qwen.js';

export interface AccountInfo {
  id: string;
  email: string;
}

export interface AccountSelectionResult {
  account: AccountInfo | null;
  lock: { release: () => void; accountId: string } | null;
  triedAccountIds: Set<string>;
  lastError: any;
  useExistingChat: boolean;
  forcedChatId: string | undefined;
  forcedAccountId: string | undefined;
  success: boolean;
}

/**
 * Check if account is on cooldown
 */
function isAccountOnCooldown(accountId: string): { onCooldown: boolean; remainingMs?: number; reason?: string } {
  const cooldownInfo = getAccountCooldownInfo(accountId);
  if (cooldownInfo && accountId !== 'global') {
    return { onCooldown: true, remainingMs: cooldownInfo.remainingMs, reason: cooldownInfo.reason };
  }
  return { onCooldown: false };
}

/**
 * Try to acquire lock for an account
 */
async function tryAcquireLock(
  accountId: string,
  requestedAccountId: string | undefined,
  agentId: string,
  requestId: string
): Promise<{ release: () => void; accountId: string } | null> {
  const lockTimeoutMs = requestedAccountId
    ? parseInt(process.env.LOCK_TIMEOUT_MS || '30000', 10)
    : 0;
  
  const lock = await acquireAccountLock(accountId, `${agentId}:${requestId}`, lockTimeoutMs);
  
  if (!lock) {
    if (requestedAccountId) {
      // Pinned account is busy even after waiting - will rotate
      const info = getLockInfo(accountId);
      console.warn(`[Chat] Pinned account ${accountId} still busy after ${lockTimeoutMs}ms (held by ${info.owner}, ${info.waiters} waiters) - rotating`);
    } else {
      // Rotating: try next account
      console.log(`[Chat] Account ${accountId} is locked by another request, trying next...`);
    }
    return null;
  }
  
  return { release: lock.release, accountId: lock.acquiredAt ? accountId : accountId }; // simplified
}

/**
 * Main account selection loop with retries and rotation
 */
export async function selectAccountAndCreateStream(
  createQwenStreamFn: Function,
  deps: {
    finalPrompt: string;
    systemPrompt?: string;  // NEW: Pass system prompt separately
    isThinkingModel: boolean;
    model: string;
    accountId: string | undefined;
    pendingMultimodal: any;
    useExistingChat: boolean;
    forcedChatId: string | undefined;
    forcedAccountId: string | undefined;
    requestedAccountId: string | undefined;
    agentId: string;
    requestId: string;
  }
): Promise<{ stream: any; accountUsed: AccountInfo | null; acquiredLock: { release: () => void; accountId: string } | null; uiSessionId: string } | null> {
  const {
    finalPrompt,
    systemPrompt,  // NEW
    isThinkingModel,
    model,
    pendingMultimodal,
    useExistingChat,
    forcedChatId,
    forcedAccountId,
    requestedAccountId,
    agentId,
    requestId
  } = deps;
  
  let account: AccountInfo | null = null;
  let triedAccountIds = new Set<string>();
  let lastError: any = null;
  let acquiredLock: { release: () => void; accountId: string } | null = null;
  let useExistingChatLocal = useExistingChat;
  let forcedChatIdLocal = forcedChatId;
  let forcedAccountIdLocal = forcedAccountId;
  let success = false;
  let stream: any = null;
  let accountUsed: AccountInfo | null = null;
  let result: any = null;
  
  try {
    while (true) {
      // S1: Account selection
      if (requestedAccountId) {
        if (triedAccountIds.has(requestedAccountId)) {
          account = getNextAvailableAccount(requestedAccountId);
        } else {
          const credentials = getAccountCredentials(requestedAccountId);
          if (!credentials) {
            console.error(`[Chat] Pinned account ${requestedAccountId} not found in database`);
            break;
          }
          account = { id: credentials.id, email: credentials.email };
        }
      } else if (forcedAccountIdLocal) {
        const credentials = getAccountCredentials(forcedAccountIdLocal);
        if (!credentials) {
          console.error(`[Chat] Forced account ${forcedAccountIdLocal} not found in database`);
          break;
        }
        account = { id: credentials.id, email: credentials.email };
      } else {
        account = getNextAccount();
      }
      
      if (!account) {
        // All accounts exhausted
        break;
      }
      
      const accountIdKey = account.id;
      const accountEmail = account.email;
      
      // Check cooldown
      const cooldownCheck = isAccountOnCooldown(accountIdKey);
      if (cooldownCheck.onCooldown) {
        console.log(`[Chat] Skipping account ${accountEmail} (${accountIdKey}) - on cooldown for ${Math.round(cooldownCheck.remainingMs! / 1000)}s (${cooldownCheck.reason})`);
        triedAccountIds.add(accountIdKey);
        account = getNextUnlockedAccount(accountIdKey);
        continue;
      }
      
      // S2: Acquire account lock
      const lock = await tryAcquireLock(accountIdKey, requestedAccountId, agentId, requestId);
      if (!lock) {
        triedAccountIds.add(accountIdKey);
        if (requestedAccountId) {
          account = getNextAvailableAccount(accountIdKey);
        } else {
          account = getNextUnlockedAccount(accountIdKey);
        }
        continue;
      }
      
      console.log(`[Chat] Routing request to account: ${accountEmail} (${accountIdKey}) [locked by ${agentId}]`);
      acquiredLock = lock;
      accountUsed = account;
      
      // Try to create stream with retries
      let retries = 3;
      let retryDelay = 500;
      
      while (retries > 0) {
        try {
          result = await createQwenStreamFn(
            finalPrompt,
            isThinkingModel,
            model,
            null,
            accountIdKey === 'global' ? undefined : accountIdKey,
            undefined,
            pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
            useExistingChatLocal ? forcedChatIdLocal : undefined,
            systemPrompt  // NEW: Pass system prompt
          );
          
          stream = result.stream;
          success = true;
          break;
        } catch (err: any) {
          retries--;
          console.error(`[Chat] createQwenStream error for ${accountEmail} (attempt ${4-retries}/3):`, err?.message, err?.upstreamCode, err?.upstreamStatus);
          lastError = err;
          
          if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
            const hourHint = err.message?.match(/Wait about (\d+)\s*hour/i);
            const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : 19 * 60 * 60 * 1000;
            
            markAccountRateLimited(accountIdKey, cooldownMs, 'RateLimited');
            console.warn(`[Chat] Account ${accountEmail} (${accountIdKey}) rate-limited (cooldown: ${cooldownMs / 3600000}h).`);
            
            if (useExistingChatLocal) {
              console.log(`[Chat] Session failed, falling back to new session`);
              useExistingChatLocal = false;
              forcedChatIdLocal = undefined;
              forcedAccountIdLocal = undefined;
              triedAccountIds.add(accountIdKey);
              if (acquiredLock) { acquiredLock.release(); acquiredLock = null; }
              account = getNextUnlockedAccount(accountIdKey);
              retries = 3;
              continue;
            }
            // Rotate immediately
            triedAccountIds.add(accountIdKey);
            if (acquiredLock) { acquiredLock.release(); acquiredLock = null; }
            account = getNextUnlockedAccount(accountIdKey);
            break;
          }
          
          if (retries === 0) {
            if (err.upstreamStatus && err.upstreamStatus >= 500) {
              markAccountRateLimited(accountIdKey, undefined, 'ServerError');
              console.warn(`[Chat] Account ${accountEmail} (${accountIdKey}) returned server error.`);
            }
            
            if (useExistingChatLocal) {
              console.log(`[Chat] Session failed, falling back to new session`);
              useExistingChatLocal = false;
              forcedChatIdLocal = undefined;
              forcedAccountIdLocal = undefined;
              triedAccountIds.add(accountIdKey);
              if (acquiredLock) { acquiredLock.release(); acquiredLock = null; }
              account = getNextUnlockedAccount(accountIdKey);
              retries = 3;
              continue;
            }
            
            // For pinned accounts: fail fast after retries exhausted
            if (requestedAccountId) {
              console.warn(`[Chat] Pinned account ${accountIdKey} failed after retries, returning error`);
              if (acquiredLock) { acquiredLock.release(); acquiredLock = null; }
              success = false;
              break;
            }
            break;
          }
          
          let useDelay = retryDelay;
          if (err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined) {
            useDelay = err.retryAfterMs;
          }
          
          const isRetryable = err instanceof RetryableQwenStreamError || 
            err.message?.includes('in progress') || 
            err.message?.includes('Bad_Request');
          
          if (!isRetryable) {
            lastError = err;
            break;
          }
          
          console.warn(`[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`);
          await new Promise(r => setTimeout(r, useDelay));
          retryDelay = Math.min(retryDelay * 2, 5000);
        }
      }
      
      if (success) {
        break;
      }
      
      // If pinned account failed after retries, break outer loop
      if (requestedAccountId && !success && account) {
        console.warn(`[Chat] Pinned account ${account.id} failed, not rotating to other accounts`);
        break;
      }
      
      // Release current lock before trying next account
      if (acquiredLock) {
        acquiredLock.release();
        acquiredLock = null;
      }
      
      if (account) triedAccountIds.add(account.id);
      
      // Try next account
      const nextAccountId = account?.id;
      account = nextAccountId ? getNextUnlockedAccount(nextAccountId) : getNextUnlockedAccount(undefined);
      
      // Check if we've exhausted all AVAILABLE accounts
      if (!account || (account.id && triedAccountIds.has(account.id))) {
        console.warn(`[Chat] All available accounts exhausted (tried: ${triedAccountIds.size})`);
        break;
      }
    }
  } finally {
    // Lock is released in specific paths above
  }
  
  if (!stream) {
    return null;
  }
  
  return { stream: result.stream, accountUsed, acquiredLock, uiSessionId: result.uiSessionId };
}