// Token links (lib/links.mjs): the fallback order, wrapped tokens, no guessing, the daily cache, the budgets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BudgetError } from '../lib/budget.mjs';
import { linkOf, makeLinksCache, resolveLinks, cgByContract, cmcByContract, WRAPPED } from '../lib/links.mjs';

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'links-')), 'links.json');
const err = (status) => Object.assign(new Error('HTTP ' + status), { status });
const DAY = 86400e3, T = Date.UTC(2026, 10, 22, 12);

test('linkOf: CoinMarketCap first, then CoinGecko, else none; older data without links', () => {
  assert.deepEqual(linkOf({ cmc: 'uniswap', cg: 'uniswap' }), { site: 'CoinMarketCap', url: 'https://coinmarketcap.com/currencies/uniswap/' });
  assert.deepEqual(linkOf({ cmc: null, cg: 'uniswap' }), { site: 'CoinGecko', url: 'https://www.coingecko.com/en/coins/uniswap' });
  assert.equal(linkOf({ cmc: null, cg: null }), null);
  assert.equal(linkOf(undefined), null);
  assert.equal(linkOf({ cmc: '../x', cg: 'a b' }), null); // never a broken or injected path
});

test('wrapped tokens link to the coin they wrap; with no CoinMarketCap key cmc stays null', async () => {
  assert.equal(WRAPPED[`ethereum:${WETH}`].cg, 'ethereum');
  const r = await resolveLinks([{ chain: 'ethereum', addr: WETH.toUpperCase().replace('0X', '0x'), cg: 'weth' }], { getJson: async () => { throw new Error('no call'); }, cache: makeLinksCache(null, { now: T }), spacingMs: 0 });
  assert.deepEqual(r.of('ethereum', WETH), { cmc: null, cg: 'ethereum' });
  const k = await resolveLinks([{ chain: 'ethereum', addr: WETH, cg: null }], { getJson: async () => { throw new Error('no call'); }, cmcKey: 'k', cache: makeLinksCache(null, { now: T }), spacingMs: 0 });
  assert.deepEqual(k.of('ethereum', WETH), { cmc: 'ethereum', cg: 'ethereum' });
  assert.deepEqual(k.sent, { cg: 0, cmc: 0 });
});

test('the pool list coin id is used as is; a missing one is looked up by contract, once a UTC day', async () => {
  const file = tmp();
  let calls = 0;
  const getJson = async (url) => { calls++; assert.match(url, /\/coins\/ethereum\/contract\/0x2{40}$/); throw err(404); };
  const toks = [{ chain: 'ethereum', addr: A, cg: 'alpha' }, { chain: 'ethereum', addr: B, cg: null }];
  const c1 = makeLinksCache(file, { now: T });
  const r = await resolveLinks(toks, { getJson, cache: c1, spacingMs: 0 });
  c1.save();
  assert.deepEqual(r.of('ethereum', A), { cmc: null, cg: 'alpha' });
  assert.deepEqual(r.of('ethereum', B), { cmc: null, cg: null });
  assert.deepEqual(r.counts, { cg: 1, cmc: 0, none: 1 });
  assert.equal(r.line(), 'links: 1 cg, 0 cmc, 1 none · cmc key: absent · lookups 1 cg, 0 cmc');
  await resolveLinks(toks, { getJson, cache: makeLinksCache(file, { now: T + 3600e3 }), spacingMs: 0 });
  assert.equal(calls, 1, 'a miss is not asked again the same UTC day');
  await resolveLinks(toks, { getJson, cache: makeLinksCache(file, { now: T + DAY }), spacingMs: 0 });
  assert.equal(calls, 2, 'asked again the next day');
});

test('CoinGecko contract lookup: only an answer that lists this address', async () => {
  assert.equal(await cgByContract(async () => ({ id: 'beta', platforms: { ethereum: B } }), 'ethereum', B), 'beta');
  assert.equal(await cgByContract(async () => ({ id: 'other', platforms: { ethereum: A } }), 'ethereum', B), null);
  assert.equal(await cgByContract(async () => ({ id: 'beta', platforms: { base: B } }), 'base', B), 'beta');
  assert.equal(await cgByContract(async () => { throw err(404); }, 'ethereum', B), null);
  await assert.rejects(cgByContract(async () => { throw err(500); }, 'ethereum', B));
});

test('CoinMarketCap: the key in the header, the slug only when the contract matches and one coin answers', async () => {
  let seen;
  const one = { data: { 7083: { id: 7083, slug: 'uniswap', contract_address: [{ contract_address: B.toUpperCase().replace('0X', '0x'), platform: { name: 'Ethereum' } }] } } };
  assert.equal(await cmcByContract(async (u, init) => { seen = [u, init]; return one; }, B, { key: 'k' }), 'uniswap');
  assert.match(seen[0], /^https:\/\/pro-api\.coinmarketcap\.com\/v2\/cryptocurrency\/info\?address=0x2{40}/);
  assert.equal(seen[1].headers['X-CMC_PRO_API_KEY'], 'k');
  assert.equal(await cmcByContract(async () => ({ data: { 1: { slug: 'wrong', platform: { token_address: A } } } }), B, { key: 'k' }), null);
  assert.equal(await cmcByContract(async () => ({ data: { 1: { slug: 'x', platform: { token_address: B } }, 2: { slug: 'y', platform: { token_address: B } } } }), B, { key: 'k' }), null);
  assert.equal(await cmcByContract(async () => ({ data: {} }), B, { key: 'k' }), null);
});

test('CoinMarketCap with a key: resolved, cached 30 days, a refused key stops the pass and keeps earlier slugs', async () => {
  const file = tmp();
  const ans = (addr, slug) => ({ data: { 9: { slug, platform: { token_address: addr } } } });
  let calls = 0;
  const cmcGetJson = async (u) => { calls++; return u.includes(A) ? ans(A, 'alpha-coin') : ans(B, 'beta-coin'); };
  const toks = [{ chain: 'ethereum', addr: A, cg: 'alpha' }, { chain: 'base', addr: B, cg: 'beta' }];
  const c1 = makeLinksCache(file, { now: T });
  const r = await resolveLinks(toks, { getJson: async () => ({}), cmcGetJson, cmcKey: 'k', cache: c1, spacingMs: 0 });
  c1.save();
  assert.deepEqual(r.of('ethereum', A), { cmc: 'alpha-coin', cg: 'alpha' });
  assert.deepEqual(r.counts, { cg: 0, cmc: 2, none: 0 });
  assert.equal(r.line(), 'links: 0 cg, 2 cmc, 0 none · cmc key: present · lookups 0 cg, 2 cmc');
  await resolveLinks(toks, { getJson: async () => ({}), cmcGetJson, cmcKey: 'k', cache: makeLinksCache(file, { now: T + 29 * DAY }), spacingMs: 0 });
  assert.equal(calls, 2, 'found slugs are kept 30 days');
  let refused = 0;
  const r2 = await resolveLinks(toks, { getJson: async () => ({}), cmcGetJson: async () => { refused++; throw err(401); }, cmcKey: 'k', cache: makeLinksCache(file, { now: T + 31 * DAY }), spacingMs: 0 });
  assert.equal(refused, 1, 'a refused key is not asked again this pass');
  assert.equal(r2.of('base', B).cmc, 'beta-coin', 'an earlier slug stays');
});

test('budgets: maxCg caps the lookups; a CoinGecko budget refusal stops them; apis.allow is honoured', async () => {
  const toks = Array.from({ length: 5 }, (_, i) => ({ chain: 'ethereum', addr: '0x' + String(i + 3).repeat(40), cg: null }));
  let n = 0;
  await resolveLinks(toks, { getJson: async () => { n++; throw err(404); }, cache: makeLinksCache(null, { now: T }), maxCg: 2, spacingMs: 0 });
  assert.equal(n, 2);
  n = 0;
  await resolveLinks(toks, { getJson: async () => { n++; throw new BudgetError('coingecko daily'); }, cache: makeLinksCache(null, { now: T }), spacingMs: 0 });
  assert.equal(n, 1, 'a budget refusal stops the lookups');
  n = 0;
  await resolveLinks(toks, { getJson: async () => { n++; return {}; }, cache: makeLinksCache(null, { now: T }), apis: { allow: () => false }, spacingMs: 0 });
  assert.equal(n, 0);
});

test('a broken cache file is an empty cache; bad input tokens are skipped', async () => {
  const file = tmp();
  fs.writeFileSync(file, '{oops');
  const c = makeLinksCache(file, { now: T });
  assert.equal(c.get('cg', 'ethereum:' + A), undefined);
  const r = await resolveLinks([{ chain: 'ethereum', addr: 'nope', cg: 'x' }, null], { getJson: async () => ({}), cache: c, spacingMs: 0 });
  assert.deepEqual(r.counts, { cg: 0, cmc: 0, none: 0 });
  assert.deepEqual(r.of('ethereum', 'nope'), { cmc: null, cg: null });
});
