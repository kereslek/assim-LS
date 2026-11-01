// contract-verified: planted faults (unverified source, refused API) must not pass. Made-up addresses and key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVerified, makeVerifiedCache, verifiedSources } from '../lib/etherscan.mjs';

const A = (c) => '0x' + c.repeat(40);
const ok = (src) => ({ status: '1', message: 'OK', result: [{ SourceCode: src, ContractName: 'T' }] });

test('getsourcecode answers: source = verified, empty = not, anything else = unread', () => {
  assert.equal(readVerified(ok('contract T {}')), true);
  assert.equal(readVerified(ok('')), false); // planted: an unverified token
  assert.equal(readVerified({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }), null);
  assert.equal(readVerified(null), null);
});

test('tokens are read once a week; the key stays out of the cache; a refused call is unread', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'es-')), 'c', 'etherscan.json');
  let n = 0;
  const getJson = async (url) => { n++; if (url.includes(A('3'))) throw new Error('HTTP 429'); return url.includes(A('2')) ? ok('') : ok('src'); };
  const now = Date.UTC(2026, 10, 1);
  const c1 = makeVerifiedCache(file, { now });
  const r1 = await verifiedSources(getJson, [A('1'), A('2'), A('3')], { key: 'made-up-key', cache: c1, spacingMs: 0 });
  c1.save();
  assert.deepEqual([...r1.verified.values()], [true, false, null]);
  assert.equal(r1.lastError, 'HTTP 429');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('made-up-key'));
  const before = n;
  const r2 = await verifiedSources(getJson, [A('1'), A('2')], { key: 'made-up-key', cache: makeVerifiedCache(file, { now: now + 6 * 86400e3 }), spacingMs: 0 });
  assert.equal(n, before); // within the week: no calls
  assert.deepEqual([...r2.verified.values()], [true, false]);
  await verifiedSources(getJson, [A('1')], { key: 'k', cache: makeVerifiedCache(file, { now: now + 8 * 86400e3 }), spacingMs: 0 });
  assert.equal(n, before + 1); // a week later: read again
  const none = await verifiedSources(getJson, [A('4')], { spacingMs: 0 }); // no key: unread, never a pass
  assert.equal(none.verified.get(A('4')), null);
});
