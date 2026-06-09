import crypto from 'crypto'
import { getDatabase } from './database.js'
import { config } from './config.js'

export interface QwenAccount {
  id: string
  email: string
  password: string
}

let accountsCache: QwenAccount[] | null = null
let accountsCacheTimestamp = 0
const ACCOUNTS_CACHE_TTL = config.cache.defaultTTL * 1000

function getCachedAccounts(): QwenAccount[] {
  const now = Date.now()
  if (!accountsCache || (now - accountsCacheTimestamp) > ACCOUNTS_CACHE_TTL) {
    const db = getDatabase()
    accountsCache = db.prepare('SELECT id, email, password FROM accounts ORDER BY created_at ASC').all() as QwenAccount[]
    accountsCacheTimestamp = now
  }
  return accountsCache
}

export function invalidateAccountsCache(): void {
  accountsCache = null
  accountsCacheTimestamp = 0
}

export function loadAccounts(): QwenAccount[] {
  return getCachedAccounts()
}

export function addAccount(email: string, password: string, id?: string): QwenAccount {
  if (!email || typeof email !== 'string' || email.trim().length === 0) {
    throw new Error('Email is required')
  }

  const db = getDatabase()
  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email.trim())
  if (existing) {
    throw new Error(`Account with email ${email} already exists`)
  }

  const newAccount: QwenAccount = {
    id: id || crypto.randomUUID(),
    email: email.trim(),
    password,
  }

  db.prepare('INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)').run(
    newAccount.id,
    newAccount.email,
    newAccount.password,
  )

  invalidateAccountsCache()
  return newAccount
}

export function removeAccount(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  if (result.changes > 0) {
    invalidateAccountsCache()
  }
  return result.changes > 0
}

export function listAccounts(): QwenAccount[] {
  return getCachedAccounts().map(a => ({ id: a.id, email: a.email, password: '***' }))
}

export function getAccountCredentials(id: string): QwenAccount | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT id, email, password FROM accounts WHERE id = ?').get(id)
  return row as QwenAccount | undefined
}
