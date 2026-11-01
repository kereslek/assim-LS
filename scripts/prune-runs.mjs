// Delete finished workflow runs older than 7 days (owner pre-approved: a public repo's run logs are
// public). Pages through every run first, then deletes; never touches a run that isn't completed.
// Prints counts only.
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/prune-runs.mjs [--days 7] [--max 800] [--dry-run]
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';

// A tiny GitHub REST client. Returns { status, json, headers }; never throws on an HTTP status.
export function githubApi({ token, fetchFn = globalThis.fetch, base = API } = {}) {
  return async (method, p, { redirect = 'follow' } = {}) => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetchFn(p.startsWith('http') ? p : base + p, {
          method, redirect,
          headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'lps-ops', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        });
        if (r.status >= 500 && i < 2) { await new Promise((ok) => setTimeout(ok, 1000 * (i + 1))); continue; }
        const json = (r.headers.get?.('content-type') || '').includes('json') ? await r.json() : null;
        return { status: r.status, json, headers: r.headers };
      } catch (e) {
        if (i === 2) return { status: 0, json: null, headers: null };
        await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
      }
    }
    return { status: 0, json: null, headers: null };
  };
}

// Every run of the repo, newest first. Throws if a page can't be read: a half list must not look whole.
export async function listRuns(api, repo, { perPage = 100, maxPages = 200 } = {}) {
  const runs = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await api('GET', `/repos/${repo}/actions/runs?per_page=${perPage}&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.json?.workflow_runs)) throw new Error(`unread: run list page ${page} answered ${r.status}`);
    runs.push(...r.json.workflow_runs);
    if (r.json.workflow_runs.length < perPage) return { runs, total: r.json.total_count ?? runs.length };
  }
  return { runs, total: null };
}

export function planPrune(runs, { now = Date.now(), days = 7, selfId = null } = {}) {
  const cutoff = now - days * 86400e3;
  const seen = new Set(), old = [], keptActive = [];
  for (const r of runs) {
    if (seen.has(r.id)) continue; // pages shift while runs start: count each once
    seen.add(r.id);
    const t = Date.parse(r.created_at);
    if (!(t < cutoff)) continue;
    if (r.status !== 'completed' || String(r.id) === String(selfId)) { keptActive.push(r); continue; }
    old.push(r);
  }
  return { unique: seen.size, old, keptActive };
}

export async function pruneRuns({ api, repo, now = Date.now(), days = 7, max = 800, dryRun = false, selfId = null, say = console.log }) {
  const { runs } = await listRuns(api, repo);
  const plan = planPrune(runs, { now, days, selfId });
  say(`runs listed: ${plan.unique}; finished and older than ${days} days: ${plan.old.length}; older but not finished (kept): ${plan.keptActive.length}`);
  const todo = plan.old.slice(0, max);
  if (dryRun) { say(`dry run: would delete ${todo.length}; nothing deleted`); return { deleted: 0, failed: 0, planned: todo.length }; }
  let deleted = 0, gone = 0, failed = 0;
  for (const r of todo) {
    const res = await api('DELETE', `/repos/${repo}/actions/runs/${r.id}`);
    if (res.status === 204) deleted++;
    else if (res.status === 404) gone++;
    else failed++;
  }
  say(`deleted: ${deleted}; already gone: ${gone}; failed: ${failed}; left for the next run (over the cap of ${max}): ${plan.old.length - todo.length}`);
  return { deleted, gone, failed, planned: todo.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: selfId } = process.env;
  try {
    if (!token || !repo) throw new Error('missing GITHUB_TOKEN or GITHUB_REPOSITORY');
    const days = Number(arg('--days') || 7), max = Number(arg('--max') || 800);
    if (!(days >= 1)) throw new Error('bad --days: at least 1');
    const r = await pruneRuns({ api: githubApi({ token }), repo, days, max, dryRun: argv.includes('--dry-run'), selfId });
    process.exitCode = r.failed ? 1 : 0;
  } catch (e) {
    const m = String(e?.message || '');
    console.log(`prune failed: ${/^(missing|bad|unread)\b/.test(m) ? m : e?.name || 'Error'}`);
    process.exitCode = 1;
  }
}
