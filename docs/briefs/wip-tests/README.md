# WIP: WebKit site tests and the v0.4.4 candidate (paused for the usage cap, 8 Nov 2026)

Live page: still **v0.4.3** (site/app/index.html, commit 6ab8182). Nothing was deployed.

## Done and pushed
- `tools/site-test.mjs`: the WebKit iPhone 15 checks wait for frames, animations and the page's own timers
  instead of fixed sleeps (sticky, header, touch/pan, table search, terms). A dispatch of only those groups,
  three times over on WebKit (run 42470799058), was green: 435 checks, 0 fail.
- New check: a tap that catches a coasting chart leaves it at rest with its reset button. It **fails on
  v0.4.3 by design** (the page bug), so a site run against site/app/index.html stays red on that check until
  v0.4.4 is live.
- `tools/candidate/index.html` (v0.4.4) fixes that bug; `v0.4.4-caught-coast.patch` is the same change as a
  diff against site/app/index.html (BUILD bump, CSP hash, settle on a caught coast).
- Backup trim job (`tools/backup-trim.mjs`, `.github/workflows/backup-trim.yml`, tests): pushed, dry run
  42471310093 green (keep 17 daily + 1 monthly, drop 0, nothing to trim).

## Still to do (the safe path)
1. Full run 1 with the candidate (site.yml, page=tools/candidate/index.html, audit=yes): run 42471350477,
   in progress at the pause (its live audit on fixtures had passed). Check both jobs are green.
2. Full run 2 with the same inputs; must be green too.
3. Dispatch backup.yml.
4. Copy tools/candidate/index.html to site/app/index.html, delete tools/candidate/, push (this deploys).
5. Wait for the pages deploy, then live-audit.yml; if anything is red, put back commit 6ab8182's page.
