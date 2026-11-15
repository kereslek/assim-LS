// The passphrase mismatch alarm (docs/briefs/guest-access.md §9). The loop writes out/loop/alarm: 'mismatch' when the
// LOCK_PASSPHRASE secret opens no owner slot of keys.json (it stopped before opening or sealing anything), 'ok' once it opens.
//   mismatch: the readable flag status.json goes on the data branch ({"lock":"mismatch","since":<ms>}, nothing else; every
//             page shows a red banner), and ONE issue "Scanner paused: passphrase mismatch" is opened (no details), so the
//             owner gets GitHub's email or push. An issue already open is left as it is (no notification each run).
//   ok:       the issue is closed (the first publish that opens has already dropped the flag).
//   node scripts/alarm.mjs        (in loop.yml, with GH_TOKEN allowed issues: write)
// Prints yes/no only.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { publishStatus } from './publish-data.mjs';

export const ALARM_FILE = 'out/loop/alarm';
export const TITLE = 'Scanner paused: passphrase mismatch';
export const BODY = [
  'The always-on scanner stopped: the passphrase in GitHub (the `LOCK_PASSPHRASE` secret) opens none of the data\'s key slots. Nothing was sealed again and nothing is lost.',
  '',
  'Fix it either way:',
  '1. Put the right passphrase back: repository **Settings → Secrets and variables → Actions → LOCK_PASSPHRASE → Update secret**.',
  '2. Or open the dashboard, tap **Use recovery key** on the unlock screen, set a new passphrase there and follow its steps.',
  '',
  'This issue closes itself on the first pass that opens.',
].join('\n');

const ghCall = (args) => spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 24 });
function openIssue(repo, gh) {
  const r = gh(['api', `repos/${repo}/issues?state=open&per_page=100`]);
  if (r.status !== 0) return { read: false, n: null };
  try { const x = JSON.parse(r.stdout).find((i) => i.title === TITLE && !i.pull_request); return { read: true, n: x ? x.number : null }; } catch { return { read: false, n: null }; }
}

export function alarm({ state, repo, gh = ghCall, flag = () => publishStatus({ say: () => {} }), say = console.log }) {
  if (state === 'mismatch') {
    let flagged = false;
    try { flagged = !!flag().flagged; } catch { flagged = false; }
    const o = openIssue(repo, gh);
    let made = false;
    if (o.read && o.n == null) made = gh(['api', '-X', 'POST', `repos/${repo}/issues`, '-f', `title=${TITLE}`, '-f', `body=${BODY}`]).status === 0;
    say(`alarm: passphrase mismatch; flag on the data branch: ${flagged ? 'yes' : 'no'}; issue: ${made ? 'opened' : o.n != null ? 'already open' : 'not opened (unread)'}`);
    return { flagged, issue: made ? 'opened' : o.n != null ? 'open' : 'unread' };
  }
  if (state === 'ok') {
    const o = openIssue(repo, gh);
    if (o.n == null) { say(`alarm: none${o.read ? '' : ' (issues unread)'}`); return { closed: false }; }
    gh(['api', '-X', 'POST', `repos/${repo}/issues/${o.n}/comments`, '-f', 'body=Cleared: the passphrase opens again and the scanner runs.']);
    const closed = gh(['api', '-X', 'PATCH', `repos/${repo}/issues/${o.n}`, '-f', 'state=closed', '-f', 'state_reason=completed']).status === 0;
    say(`alarm: cleared; issue closed: ${closed ? 'yes' : 'no'}`);
    return { closed };
  }
  say('alarm: nothing to do (the loop wrote no state)');
  return {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let state = '';
  try { state = fs.readFileSync(ALARM_FILE, 'utf8').trim(); } catch { state = ''; }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) { console.log('alarm: GITHUB_REPOSITORY is not set'); process.exitCode = 1; }
  else alarm({ state, repo });
}
