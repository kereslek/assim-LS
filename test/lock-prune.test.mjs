// Prune: delete finished runs older than 7 days, after paging through every run; never a run that is
// still going, never this run. A fake API stands in for GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { githubApi, listRuns, planPrune, pruneRuns } from '../scripts/prune-runs.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const day = 86400e3;
const iso = (t) => new Date(t).toISOString();

function fake(runs, { failPage = null, failDelete = null } = {}) {
  const deleted = [];
  const api = async (method, p) => {
    const m = p.match(/runs\?per_page=(\d+)&page=(\d+)/);
    if (method === 'GET' && m) {
      const [n, pg] = [Number(m[1]), Number(m[2])];
      if (pg === failPage) return { status: 502, json: null };
      return { status: 200, json: { total_count: runs.length, workflow_runs: runs.slice((pg - 1) * n, pg * n) } };
    }
    const d = p.match(/runs\/(\d+)$/);
    if (method === 'DELETE' && d) {
      const id = Number(d[1]);
      if (id === failDelete) return { status: 500 };
      if (!runs.some((r) => r.id === id)) return { status: 404 };
      deleted.push(id);
      return { status: 204 };
    }
    return { status: 400 };
  };
  return { api, deleted };
}

// 250 runs: 3 pages. Old finished ones (to delete), old unfinished ones (kept), new ones (kept).
const RUNS = Array.from({ length: 250 }, (_, i) => {
  const id = 1000 - i;
  const t = NOW - (i < 100 ? 2 * day : 8 * day + i * 1000);
  const status = i === 120 ? 'in_progress' : i === 121 ? 'queued' : i === 122 ? 'waiting' : 'completed';
  return { id, status, created_at: iso(t) };
});

test('plan: only finished runs older than the cutoff; duplicates counted once; this run kept', () => {
  const p = planPrune([...RUNS, RUNS[200]], { now: NOW, days: 7, selfId: RUNS[130].id });
  assert.equal(p.unique, 250);
  assert.equal(p.old.length, 150 - 3 - 1);
  assert.equal(p.keptActive.length, 4);
  assert.ok(p.old.every((r) => r.status === 'completed' && Date.parse(r.created_at) < NOW - 7 * day));
  // planted fault: a run exactly at the cutoff or a bad date is not deleted
  assert.equal(planPrune([{ id: 1, status: 'completed', created_at: iso(NOW - 7 * day) }, { id: 2, status: 'completed', created_at: 'garbage' }], { now: NOW }).old.length, 0);
});

test('prune pages through every run, deletes the old finished ones, never an active one', async () => {
  const f = fake(RUNS);
  const lines = [];
  const r = await pruneRuns({ api: f.api, repo: 'o/r', now: NOW, days: 7, say: (l) => lines.push(l) });
  assert.equal(r.deleted, 147);
  assert.equal(r.failed, 0);
  const active = new Set(RUNS.filter((x) => x.status !== 'completed').map((x) => x.id));
  assert.ok(f.deleted.every((id) => !active.has(id)), 'deleted a run that was still going');
  assert.ok(f.deleted.every((id) => id <= 900), 'deleted a run newer than 7 days');
  assert.ok(lines.every((l) => !/\b\d{3,4}\b.*\b(id|run) \d/.test(l)));
  assert.match(lines[0], /runs listed: 250/);
});

test('dry run deletes nothing; the cap leaves the rest for the next run; a failed delete is counted', async () => {
  let f = fake(RUNS);
  let r = await pruneRuns({ api: f.api, repo: 'o/r', now: NOW, dryRun: true, say: () => {} });
  assert.equal(r.planned, 147);
  assert.equal(f.deleted.length, 0);
  f = fake(RUNS);
  r = await pruneRuns({ api: f.api, repo: 'o/r', now: NOW, max: 10, say: () => {} });
  assert.equal(f.deleted.length, 10);
  f = fake(RUNS, { failDelete: RUNS[200].id });
  r = await pruneRuns({ api: f.api, repo: 'o/r', now: NOW, say: () => {} });
  assert.equal(r.failed, 1);
});

test('planted fault: an unreadable page stops the prune before anything is deleted', async () => {
  const f = fake(RUNS, { failPage: 2 });
  await assert.rejects(() => listRuns(f.api, 'o/r'), /unread/);
  await assert.rejects(() => pruneRuns({ api: f.api, repo: 'o/r', now: NOW, say: () => {} }), /unread/);
  assert.equal(f.deleted.length, 0);
});

test('the API client sends the token and retries a server error', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (calls.length === 1) return { status: 502, headers: { get: () => 'application/json' }, json: async () => ({}) };
    return { status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: 1 }) };
  };
  const api = githubApi({ token: 'made-up-token', fetchFn });
  const r = await api('GET', '/repos/o/r/actions/runs');
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/actions/runs');
  assert.equal(calls[0].auth, 'Bearer made-up-token');
});
