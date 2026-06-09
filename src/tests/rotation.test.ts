import { test } from 'node:test';
import assert from 'node:assert';
import { getNextAccount, invalidateAccountsCache } from '../core/account-manager.ts';
import { addAccount, removeAccount, loadAccounts } from '../core/accounts.ts';

test('Account Rotation: Round-Robin rotation cycle', async () => {
  const originalAccounts = loadAccounts();
  const originalIds = originalAccounts.map(a => a.id);

  const mockAccounts = [
    { email: 'account1@test.com', password: 'password1' },
    { email: 'account2@test.com', password: 'password2' },
    { email: 'account3@test.com', password: 'password3' },
  ];

  try {
    for (const acc of mockAccounts) {
      addAccount(acc.email, acc.password);
    }
    invalidateAccountsCache();

    const first = getNextAccount(true);
    const second = getNextAccount();
    const third = getNextAccount();
    const fourth = getNextAccount();

    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.ok(fourth);

    assert.strictEqual(first.email, 'account1@test.com');
    assert.strictEqual(second.email, 'account2@test.com');
    assert.strictEqual(third.email, 'account3@test.com');
    assert.strictEqual(fourth.email, 'account1@test.com');
  } finally {
    const current = loadAccounts();
    for (const acc of current) {
      if (!originalIds.includes(acc.id)) {
        removeAccount(acc.id);
      }
    }
    invalidateAccountsCache();
  }
});
