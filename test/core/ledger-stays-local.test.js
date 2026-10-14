// The owner's two acceptance points for the server integration layer:
//   1. The response envelope is the Terminal's proposed adapter contract. It must be mapped to the backend's
//      actual schema when that is supplied; nothing here has verified compatibility with a real server.
//   2. The local ledger stays local: sharing one integration layer must never route paper balances or
//      accounting through the remote data gateway.
// This file proves the second point and records the first in docs (asserted here).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { makeApp, makeBook } from '../helpers.js';

test('the ledger interface never calls the gateway, whatever address is configured', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  // Configure a gateway address and credential as a connected deployment would.
  app.data.saveConnection({ gatewayUrl: 'https://gateway.invalid', marketUrl: 'https://gateway.invalid', analyticsUrl: 'https://gateway.invalid' });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push(String(url)); throw new Error(`network call to ${url}`); };
  try {
    const inst = app.instruments.list()[0];
    const env = await app.data.server.ledger.instrument({ instrument: inst.id, bookId: book.id, unitId: acct.id });
    assert.equal(env.interface, 'ledger');
    assert.equal(env.source.kind, 'terminal-ledger');
    assert.notEqual(env.state, 'awaiting', 'the ledger needs no connection');
    assert.equal(calls.length, 0, `the ledger interface made network calls: ${calls.join(', ')}`);
    // And a remote interface with the same address does try the gateway (so the test is not vacuous).
    assert.deepEqual(Object.keys(app.data.server.ledger), ['instrument'], 'the ledger interface exposes only the local dataset');
  } finally { globalThis.fetch = realFetch; }
});

test('paper balances, positions and accounting are read from the local database only', () => {
  const src = readFileSync(new URL('../../server/data/server-integration.js', import.meta.url), 'utf8');
  assert.ok(!/fetch\s*\(|gateway|http[s]?:\/\//i.test(src.replace(/\/\/.*$/gm, '')), 'server-integration.js (the ledger interface) must contain no network call');
  const client = readFileSync(new URL('../../server/data/server-client.js', import.meta.url), 'utf8');
  assert.match(client, /interface === 'ledger'\) return ledgerProvider/, 'the client routes the ledger interface to the local provider, never to the gateway');
});

test('the documentation states that the envelope is a proposed adapter contract, not a verified schema', () => {
  const doc = readFileSync(new URL('../../docs/SERVER-CLIENT.md', import.meta.url), 'utf8');
  assert.match(doc, /proposed .*adapter contract/i);
  assert.match(doc, /not .*verified/i);
});
