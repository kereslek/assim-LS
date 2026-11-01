// The always-on loop (docs/handout.md "Keeping it always on"): one long Actions job runs a pass every
// SPACING seconds until a deadline; the workflow then dispatches its own successor (.github/workflows/loop.yml).
//
//   node scripts/loop.mjs --pass "<command>" [--mode live|rehearsal] [--by manual|self|watchdog|schedule]
//        [--spacing 360] [--deadline-min 320] [--max-passes N] [--pass-timeout-min 45] [--dry-run] [--no-restore]
//   node scripts/loop.mjs rehearsal-pass       a dummy pass: a sealed made-up live.json through lib/store.mjs
//   node scripts/loop.mjs watchdog [--dry-run] [--stale-min 20]
//
// - A failed pass never ends the loop; the process exits 1 only if every pass failed.
// - After each pass: the loop's health counters go into the sealed live.json (health.loop), then the sealed
//   files are published (--dry-run: checked, nothing pushed). Counters persist between runs inside that
//   sealed file: at start the data branch is restored (publish-data --restore) and they are read back.
//     health.loop = { passes24h, ok24h, lastGapMin (longest gap between pass starts in the last 24 h),
//                     watchdogLast (ms of the last run the watchdog started), recent: [[t, ok 1|0]] }
// - The pass command's own output goes to the sealed log only (lib/quietlogs.mjs). The public log gets
//   pass/fail, counts, dates and timings as names and seconds.
// - out/loop/successor says whether the workflow should start the next run: "no" until the loop has run
//   for 30 minutes (a loop that crashes early must not chain runs), "yes" after that in live mode.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { installSealedLogs } from '../lib/quietlogs.mjs';
import { isEnvelope, openLock } from '../lib/lock.mjs';
import { openStore } from '../lib/store.mjs';
import { publishData, restoreData } from './publish-data.mjs';

export const HOUR = 3600e3, DAY = 24 * HOUR, MIN = 60e3;
export const MARKER = 'out/loop/successor';
const GRACE = 15 * MIN;              // a pass may run this far past the deadline before it is stopped
const HANDOVER_AFTER = 30 * MIN;     // a live loop asks for a successor only once it has run this long
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const secs = (ms) => Math.round(ms / 1000);
const safeMsg = (e) => { const m = String(e?.message || ''); return /^(missing|bad|refusing|wrong|not a data file|[a-z]+\.json:)/.test(m) ? m : e?.code || e?.name || 'Error'; };

// ---- health counters (pure) ------------------------------------------------------------------------
// state = { recent: [[t, 1|0]] sorted, watchdogLast: ms|null }; recent keeps the last 24 h plus the one
// pass before them (so the first gap of the window is known).
export function seedState(loop) {
  const recent = Array.isArray(loop?.recent)
    ? loop.recent.filter((x) => Array.isArray(x) && isNum(x[0]) && x[0] > 0 && (x[1] === 0 || x[1] === 1)).map(([t, ok]) => [t, ok]).sort((a, b) => a[0] - b[0])
    : [];
  return { recent, watchdogLast: isNum(loop?.watchdogLast) ? loop.watchdogLast : null };
}

function keep24(recent, now) {
  const i = recent.findIndex(([t]) => t >= now - DAY);
  if (i < 0) return recent.slice(-1);
  return recent.slice(Math.max(0, i - 1));
}

export function recordPass(state, { t, ok }, now = t) {
  const recent = [...state.recent.filter(([x]) => x !== t), [t, ok ? 1 : 0]].sort((a, b) => a[0] - b[0]);
  return { ...state, recent: keep24(recent, now) };
}

export const markPass = (state, t, ok) => ({ ...state, recent: state.recent.map(([x, o]) => [x, x === t ? (ok ? 1 : 0) : o]) });

export function healthOf(state, now) {
  const recent = state.recent.filter(([t]) => t <= now);
  const in24 = recent.filter(([t]) => t >= now - DAY);
  let gap = null;
  for (let i = 1; i < recent.length; i++) if (recent[i][0] >= now - DAY) gap = Math.max(gap ?? 0, recent[i][0] - recent[i - 1][0]);
  return {
    passes24h: in24.length,
    ok24h: in24.filter(([, ok]) => ok === 1).length,
    lastGapMin: gap == null ? null : Math.round(gap / 6e3) / 10,
    watchdogLast: state.watchdogLast,
  };
}

// Put the counters into the sealed live.json this pass left (its t is kept: a failed pass doesn't make
// stale data look fresh). Returns 'ok', 'missing' (no live.json yet) or 'unreadable'.
export function injectHealth(store, state, { now, next = null, sealedLog = null }) {
  let live;
  try { live = store.get('live.json'); } catch { return 'unreadable'; }
  if (!live) return 'missing';
  const health = { ...(live.health || {}), loop: { ...healthOf(state, now), recent: state.recent } };
  if (health.sealedLog == null && sealedLog) health.sealedLog = sealedLog;
  store.put('live.json', { ...live, next: live.next ?? next, health });
  return 'ok';
}

// ---- the loop ----------------------------------------------------------------------------------------
// deps: { say, now, sleep, runPass, publish, restore, store, marker, sealedLog }
export async function runLoop({ passCmd, mode = 'rehearsal', by = 'manual', spacing = 360, deadlineMs = 320 * MIN, maxPasses = null,
  passTimeoutMs = 45 * MIN, dryRun = true, restore = true }, deps) {
  const { say, now, sleep, runPass, publish, store, marker } = deps;
  const t0 = now(), timing = { restore: 0, pass: 0, health: 0, publish: 0, rest: 0 };
  marker('no');
  if (!passCmd || !String(passCmd).trim()) {
    say('loop: no pass command (the live pass is not wired yet): nothing to run, no successor');
    return { passes: 0, ok: 0, exitCode: 0, refused: true, health: null };
  }
  if (restore) {
    const r0 = now();
    try { deps.restore(); } catch (e) { say(`restore failed: ${safeMsg(e)}`); }
    timing.restore += now() - r0;
  }
  let prev = null;
  try { prev = store.get('live.json'); } catch { say('restore: live.json does not open with this lock; counters start empty'); }
  let state = seedState(prev?.health?.loop);
  if (by === 'watchdog') state = { ...state, watchdogLast: t0 };
  const restored24 = healthOf(state, t0).passes24h;
  say(`loop: mode ${mode}, started by ${by}; a pass every ${spacing}s${maxPasses ? `, at most ${maxPasses} passes` : ''}; counters restored: ${restored24} passes in the last 24 h`);
  const deadline = t0 + deadlineMs, minRest = Math.min(60, spacing / 2) * 1000;
  let i = 0, ok = 0, reachedEnd = false;
  for (;;) {
    if (now() >= deadline) { reachedEnd = true; break; }
    if (maxPasses != null && i >= maxPasses) break;
    i++;
    const s = now();
    let r;
    try { r = await runPass(passCmd, { pass: i, mode, timeoutMs: Math.max(MIN, Math.min(passTimeoutMs, deadline + GRACE - s)) }); } catch { r = { ok: false, code: null, timedOut: false }; }
    const a = now() - s;
    state = recordPass(state, { t: s, ok: r.ok }, now());
    const h0 = now();
    const inj = injectHealth(store, state, { now: now(), next: s + spacing * 1000, sealedLog: deps.sealedLog?.() });
    const b = now() - h0, p0 = now();
    let pubOk = true;
    try { publish({ dryRun }); } catch (e) { pubOk = false; say(`publish failed: ${safeMsg(e)}`); }
    const c = now() - p0;
    if (!pubOk && r.ok) state = markPass(state, s, false);
    const passOk = r.ok && pubOk;
    if (passOk) ok++;
    timing.pass += a; timing.health += b; timing.publish += c;
    say(`pass ${i}: ${passOk ? 'ok' : 'FAILED'}${r.timedOut ? ' (stopped at its time limit)' : ''}${inj === 'ok' ? '' : ` (counters not written: live.json ${inj})`} · pass ${secs(a)}s, health ${secs(b)}s, publish ${secs(c)}s`);
    if (mode === 'live' && now() - t0 >= HANDOVER_AFTER) marker('yes');
    if (maxPasses != null && i >= maxPasses) break;
    const rest = Math.max(minRest, spacing * 1000 - (now() - s));
    if (now() + rest >= deadline) { reachedEnd = true; break; }
    await sleep(rest);
    timing.rest += rest;
  }
  if (mode === 'live' && reachedEnd) marker('yes');
  const h = healthOf(state, now());
  const wd = h.watchdogLast ? new Date(h.watchdogLast).toISOString().slice(0, 16) + 'Z' : 'none';
  say(`loop: ${i} passes, ${ok} ok, ${i - ok} failed; counters: ${h.passes24h} passes in 24 h (${restored24} restored), ${h.ok24h} ok, longest gap ${h.lastGapMin ?? '—'} min, watchdog last ${wd}`);
  say(`timings: ${Object.entries(timing).map(([k, v]) => `${k} ${secs(v)}s`).join(', ')}`);
  return { passes: i, ok, restored24, health: h, state, exitCode: ok > 0 ? 0 : 1, refused: false };
}

// ---- real dependencies -------------------------------------------------------------------------------
// The pass runs as a child process; its output goes to the sealed log line by line (stdout as log lines,
// stderr as warnings, so their first words become the public error categories).
export function runPassCommand(cmd, { pass, mode, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, LOOP_PASS: String(pass), LOOP_MODE: mode } });
    } catch { resolve({ ok: false, code: null, timedOut: false }); return; }
    const pipe = (stream, out) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { out(buf.slice(0, k)); buf = buf.slice(k + 1); } });
      stream.on('end', () => { if (buf) out(buf); });
    };
    pipe(child.stdout, (l) => console.log(l));
    pipe(child.stderr, (l) => console.warn(l));
    let timedOut = false;
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 10000).unref(); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, code: null, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, code, timedOut }); });
  });
}

function writeMarker(value) {
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, value + '\n');
}

// The dummy pass for rehearsals: a sealed live.json with no pools. REHEARSAL_FAIL_PASS=n plants a failure.
export function rehearsalPass({ env = process.env, store = null, t = Date.now() } = {}) {
  const n = Number(env.LOOP_PASS || 0), fail = Number(env.REHEARSAL_FAIL_PASS || 0);
  if (fail > 0 && n === fail) { console.log(`rehearsal pass ${n}: planted failure`); return 1; }
  const st = store || openStore({ env });
  st.put('live.json', {
    v: 1, t, phase: 0, build: 'rehearsal', rehearsal: true, next: null, ticket: null, stopLoss: null,
    windows: ['24h', '7d', '30d'], defaultWindow: '30d', gemAt: null, chains: [],
    health: { loop: null, checks: [], sealedLog: null }, bench: null, pools: [],
  });
  console.log(`rehearsal pass ${n}: sealed a made-up live.json with no pools`);
  return 0;
}

// ---- the watchdog --------------------------------------------------------------------------------------
// live: 'present' (with t), 'missing' (no file on the data branch) or 'unread' (the read failed: don't act on it).
export function watchdogDecision({ active, live, t = null, now, staleMin = 20 }) {
  const ageMin = live === 'present' && isNum(t) ? Math.round((now - t) / 6e3) / 10 : null;
  const stale = live === 'missing' ? true : live === 'present' ? ageMin == null || ageMin > staleMin : null;
  return { ageMin, stale, dispatch: active === 0 && stale === true };
}

const ghCall = (args) => spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

export function watchdog({ dryRun = true, staleMin = 20, repo, branch, gh = ghCall, say = console.log, now = Date.now() }) {
  let active = null;
  const runs = gh(['api', `repos/${repo}/actions/workflows/loop.yml/runs?per_page=30`]);
  try { if (runs.status === 0) active = JSON.parse(runs.stdout).workflow_runs.filter((r) => ACTIVE.has(r.status)).length; } catch { active = null; }
  let live = 'unread', t = null;
  const f = gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/live.json?ref=data`]);
  if (f.status === 0) {
    try { const env = JSON.parse(f.stdout); if (isEnvelope(env)) { live = 'present'; t = env.t; } } catch { live = 'unread'; }
  } else if (/HTTP 404|Not Found/.test(String(f.stderr))) live = 'missing';
  const d = watchdogDecision({ active, live, t, now, staleMin });
  say(`watchdog: loop runs queued or in progress ${active ?? 'unread'}; live.json on the data branch ${live}${d.ageMin != null ? `, ${d.ageMin} min old` : ''}; stale (over ${staleMin} min): ${d.stale == null ? 'unread' : d.stale ? 'yes' : 'no'}`);
  say(`watchdog: would dispatch the loop: ${d.dispatch ? 'yes' : 'no'}${dryRun ? ' (dry run: nothing dispatched)' : ''}`);
  if (d.dispatch && !dryRun) {
    const r = gh(['workflow', 'run', 'loop.yml', '--repo', repo, '--ref', branch, '-f', 'mode=live', '-f', 'by=watchdog']);
    say(`watchdog: dispatched: ${r.status === 0 ? 'yes' : 'no (dispatch failed)'}`);
    return { ...d, dispatched: r.status === 0 };
  }
  return { ...d, dispatched: false };
}

// ---- command line ----------------------------------------------------------------------------------------
async function main(argv) {
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const num = (name, envName, dflt) => { const v = Number(arg(name, process.env[envName] ?? dflt)); return Number.isFinite(v) && v > 0 ? v : dflt; };
  if (argv[0] === 'rehearsal-pass') { process.exitCode = rehearsalPass(); return; }
  if (argv[0] === 'watchdog') {
    const repo = process.env.GITHUB_REPOSITORY, branch = process.env.BRANCH || 'claude/ecstatic-dirac-wkrqja';
    if (!repo) { console.log('watchdog: GITHUB_REPOSITORY is not set'); process.exitCode = 1; return; }
    watchdog({ dryRun: argv.includes('--dry-run'), staleMin: num('--stale-min', 'STALE_MIN', 20), repo, branch });
    return;
  }
  let keys;
  try { keys = openLock().keys; } catch (e) { console.log(`loop: ${safeMsg(e)}`); process.exitCode = 1; return; }
  const { publicLog: say, stats } = installSealedLogs({ keys });
  const store = openStore({ keys });
  const mode = arg('--mode', 'rehearsal') === 'live' ? 'live' : 'rehearsal';
  const dryRun = mode !== 'live' || argv.includes('--dry-run');
  const res = await runLoop({
    passCmd: arg('--pass', ''), mode, by: arg('--by', 'manual'), dryRun, restore: !argv.includes('--no-restore'),
    spacing: num('--spacing', 'SPACING', 360), deadlineMs: num('--deadline-min', 'DEADLINE_MIN', 320) * MIN,
    maxPasses: argv.includes('--max-passes') ? num('--max-passes', '', 3) : null, passTimeoutMs: num('--pass-timeout-min', 'PASS_TIMEOUT_MIN', 45) * MIN,
  }, {
    say, store, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), runPass: runPassCommand, marker: writeMarker,
    publish: ({ dryRun: d }) => publishData({ dryRun: d, say }), restore: () => restoreData({ say }),
    sealedLog: () => ({ lines: stats().lines, errors: stats().errors, categories: stats().categories }),
  });
  if (mode === 'rehearsal' && !res.refused) {
    let back = null;
    try { back = store.get('live.json')?.health?.loop ?? null; } catch { back = null; }
    const right = !!back && back.passes24h === res.restored24 + res.passes && back.ok24h <= back.passes24h &&
      back.passes24h - back.ok24h >= res.passes - res.ok && back.passes24h === res.health.passes24h && back.ok24h === res.health.ok24h;
    say(`rehearsal: counters read back from the sealed live.json: ${back ? `${back.passes24h} passes, ${back.ok24h} ok, longest gap ${back.lastGapMin ?? '—'} min` : 'none'}; right: ${right ? 'yes' : 'no'}`);
    if (!right) res.exitCode = 1;
  }
  if (process.env.GITHUB_STEP_SUMMARY && !res.refused) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### loop (${mode})\n\n${res.passes} passes, ${res.ok} ok; ${res.health.passes24h} passes in the last 24 h, ${res.health.ok24h} ok; longest gap ${res.health.lastGapMin ?? '—'} min\n`);
    } catch { /* the summary is a nicety */ }
  }
  process.exitCode = res.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
