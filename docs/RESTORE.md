# Restoring the data branch from a backup

This file is public, like the repo: it holds no private data. Every backup is sealed: without the passphrase it
is unreadable.

## What is kept, and where (the owner's decisions, 15 Nov 2026)

| Tier | Where | Kept | Made by |
|---|---|---|---|
| Hourly | Actions artifact `backup-<stamp>` | 2 days | `backup.yml`, which the live loop dispatches when it starts and every 2 hours (`loop.yml`, "Start the sealed copies"), plus a 2-hourly cron as a fallback (every 50 minutes until 28 Nov 2026) |
| Daily | folder `<stamp>/` on the `backup` branch | the first copy of each UTC day for 90 days | `backup.yml`, on the day's first copy |
| Weekly | the same folders | the first copy of each ISO week for 365 days | (kept by the same rule) |

- **The rule:** `scripts/backup.mjs` `planRetention` keeps every folder of the last 48 hours, each day's first for 90 days, each week's first for a year, and always the newest. Each daily commit drops what the rule lets go. On the 1st of each month `backup-trim.yml` folds the branch's history into one commit with the same folders (tag `backup-pre-trim-YYYYMMDD` first) and deletes all but the newest 2 pre-trim tags.
- **At most about 2 hours of data lost:** while the loop runs, a new copy lands every 2 hours, give or take a few minutes of dispatch lag, and one when each loop run starts. When the loop is down, nothing new is made, so there is nothing new to lose.
- **A stamp** is `YYYY-MM-DDTHHMMZ` (UTC): the time the copy was taken. A folder holds the data branch's files (`live.json`, `history.json`, `snapshots.json`, `backtest.json`, `log.json`, `lock.json`) and `lock/` (the repo's lock files).
- **Size (15 Nov 2026):** one copy is about 10.2 MB, about 7.6 MB stored by git. The branch's folders come to about 130 copies, about 1.3 GB, or about 1.0 GB stored. The hourly artifacts add about 0.6 GB outside git.
- **Drill:** `restore-drill.yml` runs on Sundays and on dispatch. It decrypts the newest hourly copy and the newest branch folder, checks them against `docs/DATA.md`, rebuilds each as the data branch, has the loop's own code restore it and start a dry-run pass, and compares the counts with the live data. Public log: pass/fail, counts and ages only.

## When to restore

Only when the data branch itself is bad: a pass published broken or emptied files, or the page shows history that
is gone. A stale page is not a reason: that is the loop or the watchdog, not the data. **A real restore needs the
owner's explicit yes.** Claude may run the dry run at any time.

## Steps (the owner, or Claude after the owner's yes)

1. **Pick the stamp.** It must be from before the bad pass.
   - Branch folders: the `backup` branch on GitHub lists them by name.
   - Hourly copies: Actions → `backup` runs → each run's artifact `backup-<stamp>`.
   - Claude lists the stamps (names only): `gh api repos/kereslek/assim-LS/git/trees/backup --jq '.tree[].path'` and `gh api 'repos/kereslek/assim-LS/actions/artifacts?per_page=100' --jq '.artifacts[].name'`.
2. **Stop the loop, so it cannot publish over the restore.**
   - Disable the watchdog and the loop: Actions → `watchdog` → ⋯ → Disable workflow, then the same for `loop`. Claude: `gh api -X PUT repos/kereslek/assim-LS/actions/workflows/watchdog.yml/disable`, then the same for `loop.yml`.
   - Cancel the running loop run: Actions → `loop` → the running run → Cancel. Claude: `gh api -X POST repos/kereslek/assim-LS/actions/runs/<id>/cancel`.
   - The restore refuses while a loop run is queued or in progress.
3. **Dry run first.** Actions → `restore` → Run workflow, with `stamp` = the stamp and `dry_run` ticked (the default). The log must say every check passes and `dry run; would tag the data branch's tip as data-pre-restore-…, then replace the data branch with backup <stamp>; pushed: no`.
4. **Restore.** Run `restore` again with the same `stamp`, `confirm` = `RESTORE <stamp>` typed exactly (for example `RESTORE 2026-11-15T0911Z`), and `dry_run` unticked.
   - It tags the current data branch as `data-pre-restore-<now>` and reads the tag back.
   - Then it replaces the data branch with the backup (one commit with no parent, pushed with a lease on the tagged tip) and reads it back with the lock.
   - If the branch moved in between, it stops and restores nothing: run it again.
5. **Fix the cause before the loop runs again.** If a code change caused the bad pass, the fix goes into `loop/PIN` first.
6. **Start the loop again.**
   - Enable `loop` and `watchdog`.
   - Dispatch `loop` with mode `live`: Claude runs `gh api -X POST repos/kereslek/assim-LS/actions/workflows/loop.yml/dispatches -f ref=claude/ecstatic-dirac-wkrqja -f 'inputs[mode]=live' -f 'inputs[by]=manual'`.
   - The loop restores its state from the restored data branch at its start ("data branch present: yes; files restored …").
7. **Check.** The page shows the restored data with its own times, then a new pass. A `restore-drill` run passes.
8. **Later, with a yes:** delete the tag `data-pre-restore-<now>`. It holds the bad data, sealed.

## What Claude does and does not do

- **Does, without asking:**
  - runs `backup.yml`, `restore-drill.yml` and the restore's dry run;
  - lists stamps (names only);
  - reads the drill's pass/fail and counts.
- **Does only on the owner's explicit yes:**
  - a real restore (steps 2 and 4);
  - deleting a `data-pre-restore-*` tag;
  - `backup-trim` by hand.
- **Never:**
  - opens a backup's contents in the session (decryption happens in Actions only);
  - passes a private value as a workflow input. The stamp and the confirmation text are not private.

## If the backup branch itself is damaged

- A bad trim: the tag `backup-pre-trim-YYYYMMDD` holds the branch as it was before. Restoring it is a push of that tag's commit to `refs/heads/backup`, which needs the owner's yes.
- The hourly artifacts are independent of the branch for their 2 days.
