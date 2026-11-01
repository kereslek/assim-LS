// The always-on loop (scripts/loop.mjs) with a fake clock and a throwaway lock (dummy passphrase):
// failed passes never end it, health counters are right and persist between runs inside the sealed
// live.json, the public log holds pass/fail, counts and timings only, no successor before 30 minutes or
// in a rehearsal, and the watchdog's decision. Each check also runs against a planted fault.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initLock } from '../lib/lock.mjs';
import { openStore } from '../lib/store.mjs';
import { HOUR, MIN, DAY, seedState, recordPass, markPass, healthOf, runLoop, rehearsalPass, watchdogDecision, watchdog } from '../scripts/loop.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DUMMY = 'loop test dummy passphrase, not a secret';
const T0 = Date.UTC(2026, 10, 1, 6, 0);

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-loop-'));
  initLock({ dir: path.join(root, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const store = openStore({ lockDir: path.join(root, 'lock'), outDir: path.join(root, 'out', 'data'), env: { LOCK_PASSPHRASE: DUMMY } });
  return { root, store };
}
// Fake dependencies: a clock that moves with sleeps and pass durations; passes that fail on demand.
function fakes(store, { start = T0, passSec = 40, fails = [], publishFails = [] } = {}) {
  let clock = start;
  const lines = [], markers = [], published = [];
  const deps = {
    store, say: (s) => lines.push(s), now: () => clock, sleep: async (ms) => { clock += ms; }, marker: (v) => markers.push(v),
    restore: () => {}, sealedLog: () => ({ lines: 1, errors: 0, categories: {} }),
    publish: ({ dryRun }) => { published.push(dryRun); if (publishFails.includes(published.length)) throw new Error('bad push: made up'); },
    runPass: async (cmd, { pass }) => {
      clock += passSec * 1000;
      const code = rehearsalPass({ env: { LOOP_PASS: String(pass), REHEARSAL_FAIL_PASS: String(fails.includes(pass) ? pass : 0) }, store, t: clock });
      return { ok: code === 0, code, timedOut: false };
    },
  };
  return { deps, lines, markers, published, at: () => clock, set: (t) => { clock = t; } };
}
// The checks.
const countersRight = (h, { passes, ok, gapMin }) => h.passes24h === passes && h.ok24h === ok && (gapMin == null || Math.abs(h.lastGapMin - gapMin) < 0.2);
const PUBLIC_OK = /^[\w .,:;()/'"’\-—–±%×<>=+·]*$/u;
const publicOnly = (lines) => lines.every((l) => PUBLIC_OK.test(l) && !/0x[0-9a-f]{6,}/i.test(l) && !/\$\s?\d/.test(l));
const timingsOnly = (l) => /^timings: (\w+ \d+s)(, \w+ \d+s)*$/.test(l);

test('health counters: passes and ok passes in the last 24 h, the longest gap, pruned to 24 h plus one', () => {
  let s = seedState(null);
  const ts = [];
  for (let i = 0; i < 40; i++) ts.push(T0 + i * 6 * MIN);       // 4 hours of passes every 6 minutes
  ts.push(T0 + 4 * HOUR + 3 * HOUR);                             // then a 3-hour hole
  for (const [i, t] of ts.entries()) s = recordPass(s, { t, ok: i % 10 !== 3 });
  const now = ts.at(-1);
  assert.ok(countersRight(healthOf(s, now), { passes: 41, ok: 37, gapMin: 186 }), JSON.stringify(healthOf(s, now)));
  // a day later only the last pass and the one before the window are kept
  const later = now + DAY + MIN;
  s = recordPass(s, { t: later, ok: true });
  assert.equal(s.recent.length, 2);
  assert.ok(countersRight(healthOf(s, later), { passes: 1, ok: 1, gapMin: 24 * 60 + 1 }), JSON.stringify(healthOf(s, later)));
  // a pass whose publish failed is marked failed
  const m = markPass(s, later, false);
  assert.equal(healthOf(m, later).ok24h, 0);
  // junk in a restored file is dropped, never counted
  assert.deepEqual(seedState({ recent: [[T0, 1], ['x', 1], [T0 + 1, 2], null], watchdogLast: 'soon' }), { recent: [[T0, 1]], watchdogLast: null });
  // planted faults: ok counted as every pass, or the gap measured to the window's start, are caught
  const h = healthOf(seedState({ recent: ts.map((t, i) => [t, i % 10 !== 3 ? 1 : 0]) }), now);
  assert.equal(countersRight({ ...h, ok24h: h.passes24h }, { passes: 41, ok: 37 }), false);
  assert.equal(countersRight({ ...h, lastGapMin: (now - (now - DAY)) / MIN }, { passes: 41, ok: 37, gapMin: 186 }), false);
});

test('a failed pass never ends the loop; the run fails only if every pass failed; publish failures count', async () => {
  const { store } = setup();
  const f = fakes(store, { fails: [2] });
  const r = await runLoop({ passCmd: 'made-up pass', mode: 'rehearsal', spacing: 30, maxPasses: 3 }, f.deps);
  assert.deepEqual([r.passes, r.ok, r.exitCode], [3, 2, 0]);
  assert.ok(f.lines.some((l) => l.startsWith('pass 2: FAILED')) && f.lines.some((l) => l.startsWith('pass 3: ok')));
  assert.deepEqual(f.published, [true, true, true], 'every pass publishes, as a dry run in a rehearsal');
  const back = store.get('live.json').health.loop;
  assert.ok(countersRight(back, { passes: 3, ok: 2 }));
  assert.ok(back.lastGapMin >= 0.5 && back.lastGapMin <= 1.2, `gap ${back.lastGapMin}`);
  assert.ok(f.markers.every((m) => m === 'no'), 'no successor in a rehearsal');

  const g = fakes(setup().store, { fails: [1, 2, 3] });
  const all = await runLoop({ passCmd: 'made-up pass', mode: 'rehearsal', spacing: 30, maxPasses: 3 }, g.deps);
  assert.deepEqual([all.passes, all.ok, all.exitCode], [3, 0, 1]);

  const p = fakes(setup().store, { publishFails: [1] });
  const pub = await runLoop({ passCmd: 'made-up pass', mode: 'rehearsal', spacing: 30, maxPasses: 2 }, p.deps);
  assert.deepEqual([pub.passes, pub.ok, pub.health.ok24h], [2, 1, 1]);
  assert.ok(p.lines.includes('publish failed: bad push: made up'));
  // a pass that throws instead of failing still doesn't end the loop
  const x = fakes(setup().store);
  const real = x.deps.runPass;
  x.deps.runPass = async (cmd, o) => { if (o.pass === 2) throw new Error('made-up crash'); return real(cmd, o); };
  const thrown = await runLoop({ passCmd: 'made-up pass', mode: 'rehearsal', spacing: 30, maxPasses: 3 }, x.deps);
  assert.deepEqual([thrown.passes, thrown.ok], [3, 2]);
});

test('a live run loops until its deadline, then asks for a successor; a short-lived one does not', async () => {
  const { store } = setup();
  const f = fakes(store, { passSec: 50 });
  const r = await runLoop({ passCmd: 'made-up pass', mode: 'live', spacing: 360, deadlineMs: 60 * MIN }, f.deps);
  assert.equal(r.passes, 10, 'a pass every 6 minutes for an hour');
  assert.equal(f.markers.at(-1), 'yes');
  assert.ok(f.at() - T0 <= 60 * MIN);
  const q = fakes(setup().store);
  await runLoop({ passCmd: 'made-up pass', mode: 'live', spacing: 360, deadlineMs: 600 * MIN, maxPasses: 2 }, q.deps);
  assert.ok(q.markers.every((m) => m === 'no'), 'stopped after 2 passes (12 minutes): no successor');
  const e = fakes(setup().store);
  const none = await runLoop({ passCmd: '  ', mode: 'live' }, e.deps);
  assert.ok(none.refused && none.passes === 0 && e.markers.every((m) => m === 'no'), 'no live pass wired: nothing runs, no successor');
  // planted fault: a successor asked for at the start is caught by the marker check
  assert.notEqual(['yes', ...q.markers].every((m) => m === 'no'), true);
});

test('counters persist between runs inside the sealed live.json; the watchdog start and the gap between runs count', async () => {
  const { store } = setup();
  const a = fakes(store);
  await runLoop({ passCmd: 'made-up pass', mode: 'rehearsal', spacing: 360, maxPasses: 3 }, a.deps);
  const b = fakes(store, { start: a.at() + 2 * HOUR });
  const r = await runLoop({ passCmd: 'made-up pass', mode: 'rehearsal', by: 'watchdog', spacing: 360, maxPasses: 3 }, b.deps);
  assert.equal(r.restored24, 3);
  const back = store.get('live.json').health.loop;
  assert.ok(countersRight(back, { passes: 6, ok: 6, gapMin: 120 + 40 / 60 }), JSON.stringify(back));
  assert.equal(back.watchdogLast, a.at() + 2 * HOUR);
  assert.equal(back.recent.length, 6);
  // the envelope's readable t is the pass's own time, so a failed pass can't make stale data look fresh
  const env = JSON.parse(fs.readFileSync(path.join(store.outDir, 'live.json'), 'utf8'));
  assert.equal(env.t, store.get('live.json').t);
  // planted fault: counters that start from zero each run are caught
  assert.equal(countersRight({ ...back, passes24h: 3, ok24h: 3 }, { passes: 6, ok: 6 }), false);
});

test('the public log holds pass/fail, counts, dates and timings only', async () => {
  const { store } = setup();
  const f = fakes(store, { fails: [2] });
  await runLoop({ passCmd: 'made-up pass', mode: 'rehearsal', spacing: 30, maxPasses: 3 }, f.deps);
  assert.ok(publicOnly(f.lines), f.lines.join('\n'));
  const t = f.lines.find((l) => l.startsWith('timings:'));
  assert.ok(timingsOnly(t), t);
  assert.ok(f.lines.filter((l) => /^pass \d: /.test(l)).every((l) => / · pass \d+s, health \d+s, publish \d+s$/.test(l)));
  // planted faults: an address, an amount, or a timing with a value in it are caught
  assert.equal(publicOnly([...f.lines, 'pass 4: FAILED at 0x1f98431c8ad98523631ae4a59f267346ea31f984']), false);
  assert.equal(publicOnly([...f.lines, 'pass 4: ok, fees $1,234']), false);
  assert.equal(timingsOnly('timings: pass 12s, pool 0x1f98 3s'), false);
});

test('the watchdog dispatches only when nothing runs and the data is stale or missing', () => {
  const now = T0;
  const d = (o) => watchdogDecision({ now, staleMin: 20, ...o });
  assert.equal(d({ active: 0, live: 'present', t: now - 25 * MIN }).dispatch, true);
  assert.equal(d({ active: 0, live: 'present', t: now - 5 * MIN }).dispatch, false);
  assert.equal(d({ active: 1, live: 'present', t: now - 25 * MIN }).dispatch, false, 'a loop is running or queued');
  assert.equal(d({ active: 0, live: 'missing' }).dispatch, true);
  assert.equal(d({ active: 0, live: 'unread' }).dispatch, false, 'a failed read is not stale data');
  assert.equal(d({ active: null, live: 'missing' }).dispatch, false, 'run list unread: do nothing');
  // through fake gh answers: the dry run only prints; a real run dispatches live mode, started by the watchdog
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1]?.includes('/runs')) return { status: 0, stdout: JSON.stringify({ workflow_runs: [{ status: 'completed' }, { status: 'cancelled' }] }) };
    if (args[1] === '-H') return { status: 0, stdout: JSON.stringify({ lock: 1, t: now - 45 * MIN, iv: 'AAAA', ct: 'AAAA' }) };
    return { status: 0, stdout: '' };
  };
  const said = [];
  const dry = watchdog({ dryRun: true, repo: 'made-up/repo', branch: 'made-up-branch', gh, say: (s) => said.push(s), now });
  assert.ok(dry.dispatch && !dry.dispatched && !calls.some((c) => c[0] === 'workflow'));
  assert.ok(said.some((s) => s.includes('would dispatch the loop: yes (dry run')) && publicOnly(said));
  const real = watchdog({ dryRun: false, repo: 'made-up/repo', branch: 'made-up-branch', gh, say: () => {}, now });
  assert.ok(real.dispatched);
  assert.deepEqual(calls.at(-1), ['workflow', 'run', 'loop.yml', '--repo', 'made-up/repo', '--ref', 'made-up-branch', '-f', 'mode=live', '-f', 'by=watchdog']);
  const missing = watchdog({ dryRun: true, repo: 'r/r', branch: 'b', say: () => {}, now, gh: (args) => (args[1] === '-H' ? { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : gh(args)) });
  assert.equal(missing.dispatch, true);
  // planted fault: a decision that ignores running loops is caught
  const ignoresActive = (o) => ({ ...d(o), dispatch: d({ ...o, active: 0 }).dispatch });
  assert.notEqual(ignoresActive({ active: 1, live: 'missing' }).dispatch, d({ active: 1, live: 'missing' }).dispatch);
});

test('end to end through the script: 3 rehearsal passes, one planted failure, sealed outputs, nothing private printed', () => {
  const { root } = setup();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'loop.mjs'), '--mode', 'rehearsal', '--pass', `"${process.execPath}" "${path.join(ROOT, 'scripts', 'loop.mjs')}" rehearsal-pass`,
    '--spacing', '1', '--max-passes', '3', '--no-restore'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LOCK_PASSPHRASE: DUMMY, REHEARSAL_FAIL_PASS: '2' } });
  const out = r.stdout.split('\n').filter(Boolean);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(out.filter((l) => /^pass \d: (ok|FAILED)/.test(l)).length, 3);
  assert.ok(out.some((l) => l.startsWith('pass 2: FAILED')));
  assert.ok(out.some((l) => l.includes('dry run: would replace the "data" branch')));
  assert.ok(out.some((l) => l.includes('right: yes')), r.stdout);
  assert.ok(out.some((l) => /^timings: /.test(l)));
  assert.ok(!r.stdout.includes('sealed a made-up live.json') && !r.stdout.includes('planted failure'), 'the pass output is sealed, not printed');
  assert.equal(fs.readFileSync(path.join(root, 'out', 'loop', 'successor'), 'utf8').trim(), 'no');
  const log = JSON.parse(fs.readFileSync(path.join(root, 'out', 'data', 'log.json'), 'utf8'));
  assert.deepEqual(Object.keys(log).sort(), ['ct', 'iv', 'lock', 't', 'z']);
  const store = openStore({ lockDir: path.join(root, 'lock'), outDir: path.join(root, 'out', 'data'), env: { LOCK_PASSPHRASE: DUMMY } });
  assert.ok(countersRight(store.get('live.json').health.loop, { passes: 3, ok: 2 }));
  // a wrong passphrase stops the loop before anything runs
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'loop.mjs'), '--pass', 'true', '--max-passes', '1', '--no-restore'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, LOCK_PASSPHRASE: 'wrong' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /wrong passphrase/);
});
