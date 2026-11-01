// Leak check: no private string in any branch's any file version, commit message, file or ref name,
// or in recent run logs. Runs inside Actions; the list of private strings is built there from the
// sealed config's leakSensitive values plus every secret value the job passes in: LOCK_PASSPHRASE
// and each LEAK_SECRET_<NAME> env var (or, optionally, ALL_SECRETS as one JSON object). Prints counts
// and yes/no only, never a string, a path or where a hit was. Fails on a find, or when it couldn't
// read everything (an unread log is never counted as clean).
//   LOCK_PASSPHRASE=... LEAK_SECRET_X=... GITHUB_TOKEN=... node scripts/leak-check.mjs [--logs 300] [--no-logs]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILE, leakStrings, loadConfig } from '../lib/config.mjs';
import { githubApi, listRuns } from './prune-runs.mjs';

export const MIN_LEN = 6;
const SKIP_SECRETS = new Set(['github_token']); // a fresh token per run: never in an old object or log

// Lower-case ASCII letters only, byte for byte, so needles and haystacks fold the same way.
export function lowerAscii(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) if (out[i] >= 65 && out[i] <= 90) out[i] += 32;
  return out;
}

export function buildNeedles({ leakSensitive = [], secrets = {} } = {}) {
  const fromConfig = leakStrings({ leakSensitive }, { min: MIN_LEN });
  const secretVals = Object.entries(secrets || {}).filter(([k, v]) => !SKIP_SECRETS.has(k.toLowerCase()) && typeof v === 'string' && v.length);
  const longSecrets = [...new Set(secretVals.map(([, v]) => v.trim()).filter((v) => v.length >= MIN_LEN))];
  const all = new Set([...fromConfig.strings, ...longSecrets]);
  for (const s of [...all]) if (/^0x[0-9a-fA-F]{40,64}$/.test(s)) all.add(s.slice(2)); // addresses also appear unprefixed (topics, calldata)
  return {
    needles: [...all].map((s) => lowerAscii(Buffer.from(s, 'utf8'))),
    counts: { config: fromConfig.strings.length, secrets: longSecrets.length, short: fromConfig.short + (secretVals.length - longSecrets.length) },
  };
}

export const hits = (buf, needles) => {
  if (!needles.length) return 0;
  const hay = lowerAscii(buf);
  return needles.reduce((n, nd) => n + (hay.indexOf(nd) >= 0 ? 1 : 0), 0);
};

function git(repo, args, input) {
  const r = spawnSync('git', args, { cwd: repo, input, maxBuffer: 2 ** 31 });
  if (r.status !== 0) throw new Error(`unread: git ${args[0]} failed`);
  return r.stdout;
}

// Every object reachable from every ref (all branches, tags, remote branches): blobs are every
// version of every file, commits carry messages and names, trees carry file names. Ref names too.
export function scanGit(repo, needles) {
  const refs = git(repo, ['for-each-ref', '--format=%(refname)']);
  let found = hits(refs, needles);
  const shas = [...new Set(git(repo, ['rev-list', '--all', '--objects']).toString('utf8').split('\n').filter(Boolean).map((l) => l.slice(0, l.indexOf(' ') < 0 ? l.length : l.indexOf(' '))))];
  const out = git(repo, ['cat-file', '--batch'], shas.join('\n') + '\n');
  let p = 0, objects = 0;
  while (p < out.length) {
    const nl = out.indexOf(10, p);
    const head = out.toString('utf8', p, nl).split(' ');
    if (head[1] === 'missing') throw new Error('unread: a git object is missing');
    const size = Number(head[2]);
    const body = out.subarray(nl + 1, nl + 1 + size);
    if (body.length !== size) throw new Error('unread: a git object came back short');
    found += hits(body, needles) ? 1 : 0;
    objects++;
    p = nl + 1 + size + 1;
  }
  if (objects !== shas.length) throw new Error('unread: not every git object was read');
  return { refs: refs.toString('utf8').split('\n').filter(Boolean).length, objects, found };
}

// A minimal zip reader (stored and deflate entries, via the central directory), for run-log archives.
export function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('bad zip: no end record');
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip: broken directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), loff = buf.readUInt32LE(p + 42);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    if (csize === 0xffffffff || loff === 0xffffffff) throw new Error('bad zip: zip64 not supported');
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (buf.readUInt32LE(loff) !== 0x04034b50) throw new Error('bad zip: broken entry');
    const start = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error('bad zip: unsupported compression');
  }
  return out;
}

// Recent finished runs' logs: download each archive (the API answers with a redirect to storage,
// fetched without the token), unzip, search names and contents.
export async function scanRunLogs({ api, repo, needles, maxRuns = 300, fetchFn = globalThis.fetch, concurrency = 4 }) {
  const { runs } = await listRuns(api, repo);
  const done = [...new Map(runs.filter((r) => r.status === 'completed').map((r) => [r.id, r])).values()].slice(0, maxRuns);
  const res = { runs: done.length, read: 0, gone: 0, unread: 0, found: 0 };
  let i = 0;
  const one = async (run) => {
    const r = await api('GET', `/repos/${repo}/actions/runs/${run.id}/logs`, { redirect: 'manual' });
    if (r.status === 404 || r.status === 410) { res.gone++; return; }
    const loc = r.headers?.get?.('location');
    if (!(r.status >= 300 && r.status < 400 && loc)) { res.unread++; return; }
    for (let k = 0; k < 3; k++) {
      try {
        const z = await fetchFn(loc);
        if (!z.ok) throw new Error('http');
        const entries = unzip(Buffer.from(await z.arrayBuffer()));
        if (entries.some((en) => hits(Buffer.from(en.name, 'utf8'), needles) || hits(en.data, needles))) res.found++;
        res.read++;
        return;
      } catch { /* retry */ }
    }
    res.unread++;
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, done.length) }, async () => { while (i < done.length) await one(done[i++]); }));
  return res;
}

export async function leakCheck({ repo = '.', lockDir = 'lock', env = process.env, logs = true, maxRuns = 300, api = null, fetchFn, say = console.log } = {}) {
  let leakSensitive = [], sealed = false;
  if (fs.existsSync(path.join(repo, lockDir, CONFIG_FILE))) {
    ({ config: { leakSensitive }, sealed } = loadConfig({ dir: path.join(repo, lockDir), env })); // wrong passphrase: throws
  }
  let secrets = {};
  if (env.ALL_SECRETS) { try { secrets = JSON.parse(env.ALL_SECRETS); } catch { throw new Error('bad ALL_SECRETS: not JSON'); } }
  if (env.LOCK_PASSPHRASE) secrets.LOCK_PASSPHRASE = env.LOCK_PASSPHRASE;
  for (const [k, v] of Object.entries(env)) if (k.startsWith('LEAK_SECRET_') && v) secrets[k.slice(12)] = v;
  const { needles, counts } = buildNeedles({ leakSensitive, secrets });
  say(`sealed config present: ${sealed ? 'yes' : 'no'}`);
  say(`private strings searched: ${needles.length} (sealed config ${counts.config}, secrets ${counts.secrets}; too short to search: ${counts.short})`);
  let complete = needles.length > 0;
  if (!needles.length) say('nothing to search for: complete: no');
  const g = scanGit(repo, needles);
  say(`git: ${g.objects} objects across ${g.refs} refs (every file version, commit message, file and ref name); found: ${g.found}`);
  let lg = null;
  if (logs) {
    const repoName = env.GITHUB_REPOSITORY;
    if (!repoName || !(api || env.GITHUB_TOKEN)) { say('run logs: no token or repository: complete: no'); complete = false; }
    else {
      lg = await scanRunLogs({ api: api || githubApi({ token: env.GITHUB_TOKEN }), repo: repoName, needles, maxRuns, ...(fetchFn ? { fetchFn } : {}) });
      say(`run logs: ${lg.read} of ${lg.runs} finished runs read (${lg.gone} already deleted, ${lg.unread} unread); found: ${lg.found}`);
      if (lg.unread) complete = false;
    }
  } else say('run logs: skipped (--no-logs)');
  const found = g.found + (lg?.found || 0);
  say(`leak found: ${found ? 'yes' : 'no'}`);
  say(`complete: ${complete ? 'yes' : 'no'}`);
  return { found, complete, git: g, logs: lg };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const r = await leakCheck({ logs: !argv.includes('--no-logs'), maxRuns: Number(arg('--logs') || 300) });
    process.exitCode = r.found || !r.complete ? 1 : 0;
  } catch (e) {
    const m = String(e?.message || '');
    console.log(`leak check failed: ${/^(missing|bad|unread|wrong)\b/.test(m) ? m : e?.name || 'Error'}`);
    process.exitCode = 1;
  }
}
