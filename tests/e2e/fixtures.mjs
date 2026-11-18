// P1e: the specs run against a ledger that needs its access token. `request` sends the
// token from the file next to the test database, like the CLI; `page` signs in the way
// a person does, with a one-time /login code, so the browser holds only the cookie.
import { test as base, expect } from '@playwright/test';
import { readTokenFile, tokenFileFor } from '../../src/token.mjs';

export { expect };

export async function ledgerToken() {
  const database = process.env.CONTEXT_LEDGER_E2E_DB;
  const token = database && (await readTokenFile(tokenFileFor(database)))?.token;
  if (!token) throw new Error('The e2e ledger wrote no readable token file.');
  return token;
}

/**
 * Signs a page in through a fresh one-time code. It leaves the page on about:blank, so
 * a spec's first goto('/#room=...') is a full load, as it was before sign-in existed.
 */
export async function signIn(page, request) {
  const minted = await request.post('/api/login');
  expect(minted.status()).toBe(200);
  const { path } = await minted.json();
  await page.goto(path);
  await expect(page).toHaveURL(/\/$/u);
  await page.goto('about:blank');
}

export const test = base.extend({
  request: async ({ playwright, baseURL }, use) => {
    const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${await ledgerToken()}` } });
    await use(context);
    await context.dispose();
  },
  page: async ({ page, request }, use) => {
    await signIn(page, request);
    await use(page);
  },
});
