/*
 * File: auto-reauth.ts
 * Project: qwenproxy
 * Automatic account re-authentication when cookies expire
 */

import { QwenAccount, loadAccounts } from './accounts.js';
import { config } from './config.js';

interface ReauthState {
  lastAttempt: number;
  attemptCount: number;
  lastError: string | null;
  isRunning: boolean;
}

const reauthStates = new Map<string, ReauthState>();

const REAUTH_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between attempts
const MAX_REAUTH_ATTEMPTS = 3;
const REAUTH_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes for reauth

function getReauthState(accountId: string): ReauthState {
  let state = reauthStates.get(accountId);
  if (!state) {
    state = {
      lastAttempt: 0,
      attemptCount: 0,
      lastError: null,
      isRunning: false,
    };
    reauthStates.set(accountId, state);
  }
  return state;
}

function resetReauthState(accountId: string): void {
  const state = getReauthState(accountId);
  state.lastAttempt = 0;
  state.attemptCount = 0;
  state.lastError = null;
  state.isRunning = false;
}

export async function reauthenticateAccount(accountId: string): Promise<boolean> {
  const state = getReauthState(accountId);
  
  if (state.isRunning) {
    console.log(`[AutoReauth] Reauth already in progress for ${accountId}`);
    return false;
  }

  const now = Date.now();
  if (now - state.lastAttempt < REAUTH_COOLDOWN_MS) {
    console.log(`[AutoReauth] Reauth cooldown active for ${accountId} (${Math.round((REAUTH_COOLDOWN_MS - (now - state.lastAttempt)) / 1000)}s remaining)`);
    return false;
  }

  if (state.attemptCount >= MAX_REAUTH_ATTEMPTS) {
    console.warn(`[AutoReauth] Max reauth attempts (${MAX_REAUTH_ATTEMPTS}) reached for ${accountId}. Manual intervention needed.`);
    return false;
  }

  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account || !account.email || !account.password) {
    console.error(`[AutoReauth] No credentials found for ${accountId}`);
    return false;
  }

  state.isRunning = true;
  state.lastAttempt = now;
  state.attemptCount++;

  console.log(`[AutoReauth] Starting reauth for ${account.email} (${accountId}) - attempt ${state.attemptCount}/${MAX_REAUTH_ATTEMPTS}`);

  try {
    const success = await performReauth(account);
    
    if (success) {
      console.log(`[AutoReauth] Reauth SUCCESS for ${account.email} (${accountId})`);
      resetReauthState(accountId);
      return true;
    } else {
      state.lastError = 'Reauth returned false';
      console.warn(`[AutoReauth] Reauth FAILED for ${account.email} (${accountId}): ${state.lastError}`);
      return false;
    }
  } catch (err: any) {
    state.lastError = err.message;
    console.error(`[AutoReauth] Reauth ERROR for ${account.email} (${accountId}):`, err.message);
    return false;
  } finally {
    state.isRunning = false;
  }
}

async function performReauth(account: QwenAccount): Promise<boolean> {
  // Use existing playwright module's getBasicHeaders which handles login internally
  // This avoids creating new browser contexts and uses already-initialized contexts
  try {
    // Dynamically import playwright module to avoid circular dependency
    const playwrightModule = await import('../services/playwright.js');
    
    // getBasicHeaders will use existing initialized context and trigger login if needed
    // This reuses the already-initialized Playwright contexts from startup
    await playwrightModule.getBasicHeaders(account.id);
    
    console.log(`[AutoReauth] Reauth SUCCESS for ${account.email} (verified via getBasicHeaders)`);
    return true;
  } catch (err: any) {
    console.error(`[AutoReauth] Reauth error for ${account.email}:`, err.message);
    return false;
  }
}

export function recordReauthError(accountId: string, error: string): void {
  const state = getReauthState(accountId);
  state.lastError = error;
}

export function shouldTriggerReauth(accountId: string, error: string): boolean {
  // Trigger reauth on 401, 403, connection errors, or "fetch failed"
  const reauthErrors = [
    '401', '403', 'Unauthorized', 'Forbidden',
    'fetch failed', 'ECONNREFUSED', 'ETIMEDOUT',
    'cookie', 'session', 'expired', 'invalid token',
    'login', 'auth'
  ];

  const lowerError = error.toLowerCase();
  return reauthErrors.some(e => lowerError.includes(e.toLowerCase()));
}

export async function getReauthStatus(accountId: string): Promise<ReauthState> {
  return { ...getReauthState(accountId) };
}

export function clearReauthState(accountId: string): void {
  reauthStates.delete(accountId);
}