import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUniverse } from '../lib/universe.mjs';
import { parseGeckoPools, parseDexScreenerPairs, venueOfGecko } from '../lib/aggregators.mjs';
import { pageLogs } from '../lib/logs.mjs';
import { ZERO } from '../lib/pools.mjs';

// Made-up coins and addresses throughout.
const a = (c) => '0x' + c.repeat(40);

test('universe: rank window, chain contract required, duplicates and quotes dropped, benchmark forced in', () => {
  const markets = [
    { id: 'alpha', symbol: 'alp', market_cap_rank: 150, current_price: 2, market_cap: 5e8, total_volume: 1e7 },
    { id: 'big', symbol: 'big', market_cap_rank: 50, current_price: 9 },
    { id: 'uniswap', symbol: 'uni', market_cap_rank: 25, current_price: 7 },
    { id: 'nochain', symbol: 'nc', market_cap_rank: 1999, current_price: 1 },
    { id: 'twin', symbol: 'tw', market_cap_rank: 300, current_price: 2 },
    { id: 'aquote', symbol: 'q', market_cap_rank: 500, current_price: 1 },
    { id: 'tail', symbol: 'tl', market_cap_rank: 2001, current_price: 1 },
    { id: 'unpriced', symbol: 'up', market_cap_rank: 900, current_price: null },
  ];
  const list = [
    { id: 'alpha', platforms: { ethereum: a('A') } }, { id: 'big', platforms: { ethereum: a('b') } },
    { id: 'uniswap', platforms: { ethereum: a('c') } }, { id: 'nochain', platforms: { solana: 'So1' } },
    { id: 'twin', platforms: { ethereum: a('a') } }, { id: 'aquote', platforms: { ethereum: a('d') } },
    { id: 'tail', platforms: { ethereum: a('e') } }, { id: 'unpriced', platforms: { ethereum: a('f') } },
  ];
  const u = buildUniverse(markets, list, { include: ['uniswap'], exclude: [a('d')] });
  assert.deepEqual(u.tokens.map((t) => t.id), ['alpha', 'uniswap', 'unpriced']);
  assert.equal(u.tokens[0].address, a('a')); // lower-cased
  assert.equal(u.tokens[0].symbol, 'ALP');
  assert.equal(u.tokens[2].usd, null); // unpriced stays unpriced, not $0
  assert.deepEqual(u.counts, { ranked: 6, onChain: 5, kept: 3 });
});

test('GeckoTerminal pools normalise to one shape; Uniswap v3/v4 recognised by dex id', () => {
  const j = { data: [
    { attributes: { address: a('1').toUpperCase().replace('0X', '0x'), name: 'ALP / WETH 0.3%', reserve_in_usd: '412345.6', pool_created_at: '2024-03-01T00:00:00Z' },
      relationships: { base_token: { data: { id: 'eth_' + a('a') } }, quote_token: { data: { id: 'eth_' + a('c') } }, dex: { data: { id: 'uniswap_v3' } } } },
    { attributes: { address: '0x' + '2'.repeat(64), name: 'ALP / ETH', reserve_in_usd: '9000' },
      relationships: { base_token: { data: { id: 'eth_' + a('a') } }, quote_token: { data: { id: 'eth_0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' } }, dex: { data: { id: 'uniswap-v4-ethereum' } } } },
    { attributes: { address: a('3'), reserve_in_usd: 'n/a' }, relationships: { dex: { data: { id: 'sushiswap' } } } },
  ] };
  const p = parseGeckoPools(j);
  assert.equal(p[0].venue, 3);
  assert.equal(p[0].id, a('1'));
  assert.equal(p[0].reserveUsd, 412345.6);
  assert.equal(p[0].quoteSymbol, 'WETH');
  assert.equal(p[1].venue, 4);
  assert.equal(p[1].quote, ZERO); // native ETH
  assert.equal(p[2].venue, null);
  assert.equal(p[2].reserveUsd, null); // unreadable is null, not 0
  assert.equal(venueOfGecko('uniswap_v2'), null);
  assert.deepEqual(parseGeckoPools(null), []);
});

test('DexScreener pairs normalise; other chains and other dexes are not Uniswap v3/v4', () => {
  const rows = [
    { chainId: 'ethereum', dexId: 'uniswap', labels: ['v3'], pairAddress: a('4'), baseToken: { address: a('a') }, quoteToken: { address: a('c'), symbol: 'WETH' }, liquidity: { usd: 350000 }, pairCreatedAt: 1700000000000 },
    { chainId: 'ethereum', dexId: 'uniswap', labels: ['v4'], pairAddress: '0x' + '5'.repeat(64), baseToken: { address: a('a') }, quoteToken: { address: ZERO }, liquidity: { usd: 1 } },
    { chainId: 'ethereum', dexId: 'uniswap', labels: ['v2'], pairAddress: a('6'), baseToken: { address: a('a') }, quoteToken: { address: a('c') } },
    { chainId: 'base', dexId: 'uniswap', labels: ['v3'], pairAddress: a('7') },
  ];
  const p = parseDexScreenerPairs(rows);
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((x) => x.venue), [3, 4, null]);
  assert.equal(p[0].quoteSymbol, 'WETH');
  assert.equal(p[2].reserveUsd, null);
});

// A fake Etherscan-style API over made-up logs: 2,350 logs on 900 blocks, ascending.
function fakeLogsApi(total = 2350, { unsorted = false, refuse = false } = {}) {
  const all = Array.from({ length: total }, (_, i) => ({ blockNumber: '0x' + (1000 + Math.floor(i / 2.6)).toString(16), transactionHash: '0xt' + i, logIndex: '0x0' }));
  let calls = 0;
  const getJson = async (url) => {
    calls++;
    const q = new URL(url).searchParams, from = +q.get('fromBlock'), to = +q.get('toBlock'), n = +q.get('offset');
    if (refuse) return { status: '0', message: 'NOTOK', result: 'Max rate limit reached' };
    let rows = all.filter((l) => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to).slice(0, n);
    if (unsorted) rows = rows.reverse();
    return rows.length ? { status: '1', result: rows } : { status: '0', message: 'No logs found', result: [] };
  };
  return { getJson, all, get calls() { return calls; } };
}

test('log pager: every log exactly once across pages; refusals and odd order are incomplete, not "no events"', async () => {
  const api = fakeLogsApi();
  const r = await pageLogs(api.getJson, { base: 'https://x/api', address: a('9'), fromBlock: 0, toBlock: 99999, spacingMs: 0 });
  assert.equal(r.complete, true);
  assert.equal(r.logs.length, api.all.length);
  assert.equal(new Set(r.logs.map((l) => l.transactionHash)).size, api.all.length);
  assert.ok(r.calls >= 3);
  const bad = await pageLogs(fakeLogsApi(10, { refuse: true }).getJson, { base: 'https://x/api', address: a('9'), fromBlock: 0, toBlock: 9, spacingMs: 0 });
  assert.equal(bad.complete, false);
  assert.equal(bad.reason, 'refused');
  const odd = await pageLogs(fakeLogsApi(2350, { unsorted: true }).getJson, { base: 'https://x/api', address: a('9'), fromBlock: 0, toBlock: 99999, spacingMs: 0 });
  assert.equal(odd.complete, false);
  const none = await pageLogs(fakeLogsApi(0).getJson, { base: 'https://x/api', address: a('9'), fromBlock: 0, toBlock: 9, spacingMs: 0 });
  assert.deepEqual([none.complete, none.logs.length], [true, 0]);
});
