# Handout: know-how from a private, always-on DeFi LP dashboard, for a new pool / liquidity scanner

> **How to use this.** Paste it into the new Claude Code session as the first message, or save it as `CLAUDE.md` in the new repo.
>
> It holds no private data: no wallet addresses, positions, amounts, holdings, keys or secret values. Keep it that way, and never add the user's private details to it.
>
> Everything here was learned building and running the old project (Oct 2026: about four weeks, one long cloud session, 12 context compactions).
> - Values marked *(verify)* are standard protocol facts that weren't re-checked against the chain.
> - The rest ran in production.

## Standing rules from the owner (1 Nov 2026)

- **Usage budget (owner, 1 Nov 2026; replaces the earlier rules).** Use at most 80% of each 5-hour usage window, and stop whenever weekly usage reaches 80%, resuming after the weekly reset (Saturday 06:00 in the owner's time zone). At most 4 helper agents run at a time.
  - Claude sees only a warning flag per window (`get_session` → `rate_limit_info`: status allowed / allowed_warning, which window, reset time), never percentages. The weekly flag already shows at about 60%, so it can't mark 80%.
  - 5-hour windows: stop at the first 5-hour warning (finish the current small step, commit and push, tell helpers to stop, schedule a wake-up for the window's reset). When the next 5-hour window opens, just continue normally: no need to ask.
  - Weekly: the owner reads the % in the Claude app (Settings → Usage). Project the burn from the owner's readings and stop at a projected 75–80%. When unsure, ping the owner once for the %, and pause until they answer or the weekly reset.
- **How work runs (1 Nov 2026).** Plan ahead: many questions and any mockups come at the start of a run, all at once (`AskUserQuestion` batches, lettered mockups with a pick). Then run unattended for as long as usage allows: build, audit, test on every device width, click every control, fix, re-audit. No small questions mid-run: anything only the owner can do is skipped, logged and listed in the end report with paste-ready steps. Phone ping (`PushNotification`) only at milestones; one report at the end: a verdict-first table in chat plus a private page with screenshots (made-up data) and every audit's pass/fail. The current plan, its run log and the owner's answers live in the private strategy doc, tab "Run plan".
- **Pre-approved during runs:** everything in the approved run plan; deleting a public log or run that leaked private data, at once; pruning finished Actions runs older than 7 days; rewriting history to remove a leaked value (backup first); putting a bug fix into the live loop once every audit passes. **Still needs a yes:** new features or schedule changes in the live loop beyond the plan, anything that costs money, wallets, keys, funds or live positions, repository settings, any other history rewrite or deletion.
- **Effort.** Most thinking (planning, analysis, design choices, reviewing results, audits' verdicts) runs at max effort in the main session. Regular work and coding go to subagents at `xhigh` or `high` effort (the Agent tool's `effort` field): `xhigh` for tricky code (on-chain decoding, crypto, the relay), `high` for routine edits, tests and docs. Each subagent gets a self-contained brief with the privacy rules.
- **Scope.** This project is assim-LS only. Other repositories attached to a session are not part of it: don't read them, change them or bring them up.

**Reference implementation:**
- Repo: `kereslek/k-telemetry` (public).
- Code on the dev branch `claude/new-session-argqhq`; the relay and the page deployed on `gh-pages`.
- Read the code for patterns. **Never open its data files** (`config.json`, `inbox.json`, `lock*.json`, `*-main.json`, `relay-log.json` and the other JSON the relay writes): they are the user's, sealed.

## The 20 rules that mattered most

1. **Privacy beats everything.**
   - Public repo, but every published file is encrypted.
   - Private inputs travel only sealed (an X25519 "inbox").
   - The relay's own log is sealed.
   - Public Actions logs show only pass/fail, counts, ratios, dates and market data.
   - Never addresses, amounts, IDs or shares, never which pools are the user's, and no "inference leaks": a "0" that reveals ownership, a ± dollar tolerance that reveals size.
2. **Missing is never zero.**
   - An unread chunk, failed call or unpriced token is `null`, and the page shows "—".
   - Keep the last good value marked stale instead of drawing a fake crash.
   - Never default a failed `eth_call` to a number.
3. **GitHub cron is best-effort.** "Every 15 min" fired about twice a day. Stay always-on with:
   - one long job that loops passes for about 5 h 20 min and then dispatches its own successor;
   - a watchdog workflow;
   - a staleness badge on the page.
4. **Data and code share `gh-pages`.**
   - Each pass does reset → generate → commit.
   - A push that changes a file the pass reads makes it throw its output away.
   - So deploy right after a "data refresh" commit, or touch only SAFE-list files.
5. **The Claude cloud session couldn't reach most chain/DEX/price hosts** (Solana RPCs, Raydium, Jupiter, DefiLlama, DexScreener, Coinbase, GeckoTerminal, Blockscout, github.io).
   - Probes ran as Actions jobs printing public data only.
   - Re-check the new environment's network policy first.
6. **Secrets live only in GitHub Actions secrets.** Never pasted into chat. Workflow-dispatch inputs are echoed in public logs, so seal anything private before passing it.
7. **Never assume the fee an LP keeps.**
   - Read v3 `slot0.feeProtocol` and v4 `protocolFee`/`lpFee`.
   - On Raydium CLMM, read the AmmConfig protocol and fund rates.
   - Assuming the full tier overstated fees by about 20%.
8. **Fee growth is the cleanest income signal.** fees = L × Δ feeGrowthInside. Harvests, deposits and withdrawals never move it.
9. **Your own swap's fee coming back to your LP is not income.** Separate it everywhere.
10. **Follow the receipt, not the event's recipient field.** The position manager often holds tokens mid-transaction: it unwraps WETH and sweeps to the caller.
11. **Read `eth_getLogs` in chunks** (9k blocks on Ethereum, 10k on L2s). Route each position to its own chain's contract, using that chain's blocks per hour.
12. **Cross-check every number against an independent source:**
    - on-chain vs the DEX's own API vs an aggregator;
    - Jupiter vs DefiLlama, switching to DefiLlama when they differ by more than 2%;
    - a pool's price counts only on days it was within 10% of market.
13. **Audit the audits.** Plant faults and make each check catch them. A new check must fail on the old code.
14. **Compare like with like:**
    - page vs relay from the same pass;
    - wait for the Pages deploy run before auditing;
    - Pages lags, so read raw.githubusercontent and Pages and take the newer copy.
15. **Use log/tick space for anything wide.** Range position = (tick − lower)/(upper − lower). A linear price scale crowds wide ranges toward the low edge.
16. **Mockups before code.** Lettered options with one marked as the pick; build only on "yes" or a letter.
17. **Answer verdict first:** a small table or bullets, one question at the end. Long text gets "that's a lot of text to read".
18. **Test every UI change on a phone (≤ 430 px) and a laptop.** Give times in the owner's time zone.
19. **Irreversible steps need an explicit yes:** history rewrites, deleting runs or logs, relay changes. Keep a one-line "awaiting your yes" list.
20. **Never show fake data.** Mockups carry a "MOCKUP · MADE-UP NUMBERS" ribbon.

**Contents:** working with this user · Claude session operations · architecture and always-on · privacy playbook · on-chain facts · data sources · deeper details · accounting rules · scanner analytics · testing and audits · GitHub gotchas · bugs → fixes · design lessons · starter plan · snippets · ideas · timeline

## Working with this user

**The rhythm that worked**
1. Idea, then the user says "don't build yet, just ideas".
2. Short analysis plus lettered mockups (A/B/C…), one marked as the recommendation, with current vs recommended side by side.
3. The user picks: "B", "build A, with X as well", "ok to all, but move X to position 11".
4. Build.
5. "Audit back": run every audit on the live page, phone and laptop.
6. Short report: build tag, where to find it, "reload if it doesn't say vX".

Notes on the rhythm:
- "Could we…?" means mockup first. Building straight away drew "you forgot to show me the mockup".
- "Just build it as best as you can" or "you tell me" means build your recommended combination now.
- Always recommend something and say why.
- If the ask is ambiguous, restate it in one line ("Got it, you want…") before building. One misread build had to be redone.

**Answer style**
- Verdict first ("You were right, the drop wasn't real, and it's fixed"), then bold-led bullets or a small table, then at most one question.
- High-level summary over low-level detail. "That's a lot of text to read, summarise in a small table or bullet points."
- Decisions "as if I was 5 years old": a plain analogy, one yes/no, the exact reply phrase to send.
- Verification answers use a "What you did | What the dashboard shows" table.
- Admit errors plainly ("My mistake…"), say what was a bug and what was real, fix history backwards, and add a regression check.
- Acknowledge every message. One request had to be resent after about 1.5 h unanswered.
- Don't repeat long "still waiting on your yes" lists or housekeeping notes: one line at most.

**Phrases and input quirks.** See the owner's private notes (strategy doc, tab "Owner notes").

**They challenge numbers, and were right several times.** Root-cause first. Check intraday before doubting a remembered figure: the daily chart once hid a real peak. Triple-validate, and say plainly when a theory was disproven.

**Gates and approvals**
- No code on "just ideas", "mockups", "analysis", "answer", "check and examine", "don't build anything, just respond here". Go on "yes", "yes to all" or a letter.
- Irreversible or risky steps (history rewrites, deleting runs or logs, relay changes) only on an explicit yes. Answer "does it carry any risks? have we done similar before?" up front.
- Ask before adding repo files for one-off research.
- User-only tasks (secrets, sign-ups, GitHub Support): numbered steps, paste-ready text, "tell me 'done'".

**Time zone, devices, look**
- Time zone and devices: See the owner's private notes (strategy doc, tab "Owner notes"). Test at 360–430, 768 and 1300–1920 px, plus reduced motion.
- Look: dark navy with a cyan accent, mono labels, one axis per chart, bars from 0, compact and space-saving ("minimal space").

**Git etiquette in their sessions**
- Develop on the session's designated branch; deploy to `gh-pages` only with their standing yes.
- No PRs unless asked. Use the commit trailers from the system prompt. No model names in commits or code.

## Claude Code session operations (cloud / web sessions)

**The environment**
- Each session runs in a fresh, short-lived cloud container. The repo is cloned at start and the container is reclaimed after inactivity, so anything worth keeping must be committed and pushed. Disk is a fixed allowance: when it runs out, delete build junk and old clones.
- Every session gets a designated dev branch: develop, commit and push there. Never push to another branch without the user's yes. The old project had a standing yes to deploy to `gh-pages`; a new project needs its own.
- No PRs unless asked. Use the commit trailers the session's system prompt gives. Never put model names or IDs in commits, PRs or code.
- Outbound HTTPS goes through an agent proxy (CA bundle `/root/.ccr/ca-bundle.crt`; `/root/.ccr/README.md` explains it). Some hosts may be blocked. Heavy or secret-needing chain reads ran inside GitHub Actions instead, so the RPC keys never entered the session.
- Chromium and Playwright come preinstalled. `require('playwright')` works from anywhere and `chromium.launch()` needs no options. Never run `playwright install`.
- Use the session scratchpad (its absolute path is in the system prompt) for splice files, tests, screenshots and drafts. Write files the user should open into the scratchpad or the repo, and send them with `SendUserFile`.

**Connectors and tools that did the work**

| Need | How |
|---|---|
| Run status, job IDs and step states | `gh api repos/OWNER/REPO/actions/runs/RUN_ID` and `.../runs/RUN_ID/jobs`. Here `gh` is a built-in client: only `gh api <REST path>` works, through the session's GitHub proxy. |
| Dispatch a workflow with inputs | GitHub MCP `mcp__github__actions_run_trigger` (`method: run_workflow`, `workflow_id: file.yml`, `ref: branch`, `inputs: {...}`). It also cancels, reruns and deletes logs. Deleting logs is irreversible: ask first. |
| Read a job's log | GitHub MCP `mcp__github__get_job_logs` (`job_id`, `return_content: true`, `tail_lines: N`). Logs of pruned or cancelled runs can be gone. |
| List runs and jobs | GitHub MCP `mcp__github__actions_list` |
| Loading those tools | GitHub MCP tools are deferred: load them first with `ToolSearch` `select:mcp__github__actions_run_trigger,mcp__github__get_job_logs,...` |
| Wait for a run | `Bash` with `run_in_background: true` and an until-loop that polls the run status every 20 s and exits on `completed`. You get one notification. Never use a foreground `sleep`. Use `Monitor` only for streams of events. |
| Come back later | Claude Code Remote MCP `send_later`, e.g. "re-check the relay pass in an hour". `create_trigger` for recurring scheduled tasks. |
| Another repo | Claude Code Remote MCP `list_repos` / `add_repo`. Don't probe with curl first: private repos look like 404s. |
| Long multi-step work | `TaskCreate` / `TaskUpdate`. The list survives context compaction and keeps the thread. |
| Questions that block a decision | `AskUserQuestion`, used rarely. For design choices, show labelled mockups (A/B) and let the user answer with a letter. |
| Wide reading (huge logs, transcripts, many files) | Subagents (`Agent`) in parallel, each with a self-contained brief including the privacy rules. You keep their conclusions, not the file dumps. |

**Surviving a weeks-long session**
- The old project was one session of about four weeks with 12 context compactions. Each compaction summary carried:
  - the user's standing constraints, verbatim;
  - the working rules;
  - the pending tasks;
  - the exact state of what was mid-flight.
- Keep those blocks current and re-read them after a compaction.
- The full transcript is `~/.claude/projects/<project>/<session>.jsonl`, and it can reach hundreds of MB. Compaction summaries are the user messages starting "This session is being continued from a previous conversation". They are the densest record. Pull them out with a streaming Node script, mask private values first, then read.
- Workflow-dispatch inputs are printed in the public job log's env block. Never pass a private value as an input: seal it to the inbox key first (see Privacy).
- A huge single-file front end (thousands of lines of HTML/CSS/JS) was edited through splice scripts in the scratchpad:
  - extract the block between known markers;
  - build the replacement;
  - `node --check` the extracted script;
  - re-insert it;
  - run a Playwright test page loaded with made-up data.
- That beat many small in-place edits on a file too big to read whole.

**More session tricks and pitfalls**
- **Deploying to gh-pages from the session:**
  1. Keep a separate clone or worktree of `gh-pages` in the scratchpad.
  2. `git fetch && git reset --hard origin/gh-pages`.
  3. Copy the built files in and commit with the trailers.
  4. Push with `pull --rebase` and retries.
  5. Mirror the change to the dev branch.
  - Commit before pulling.
  - Time the push just after a relay data commit (see "Always on").
- **Dispatch through REST:** `gh api -X POST repos/O/R/actions/workflows/F.yml/dispatches -f ref=BRANCH -f 'inputs[name]=value'`.
  - `gh api` also lists, cancels and deletes runs and enables or disables workflows.
  - It can't download logs (the redirect is refused): use the GitHub MCP `get_job_logs`.
  - The Pages API returned 403 through the proxy. Find the deploy instead by filtering `actions/runs` for `name == "pages build and deployment"`.
- **Logs:**
  - They exist only after the job ends.
  - Save big logs to a file and slice them; don't print them whole.
  - Deleting a log: `gh api -X DELETE repos/O/R/actions/runs/ID/logs`, then confirm the logs URL returns 404. It's irreversible, so ask first.
- **The GitHub API allowance is hourly:** bulk calls (mass run deletion, paging through every run) exhaust it. Run bulk jobs inside Actions.
- **Waiting:**
  - Background polling loops should compute times at runtime: a hard-coded epoch once hung a loop.
  - Watchers expire after about 2 h, so re-arm them.
  - Use `send_later` for "check again in an hour" or "remind me tomorrow at 09:00".
  - The scheduled-task quota can run out.
- **A stop hook** in these sessions demands that work is committed and pushed before a turn ends.
- **Local servers**, for testing a page with fixture data: `python3 -m http.server 8731 --bind 127.0.0.1`.
  - Kill with a bracket pattern (`pkill -f "http[.]server 873[1]"`): a plain `pkill -f` matched its own shell.
  - Servers die at the session's time limit.
- **Other pitfalls:**
  - `npm install` in the repo pruned the preinstalled Playwright.
  - `git log -S` over a big history timed out; scope it by path.
  - Python/regex replacements must match the real characters: a typographic ’ is not `'`.
- **Splicing a huge page:**
  - CSS goes before the first `</style>`; JS goes before a stable marker comment.
  - Plain-string replacement beat regex.
  - Keep each splice step independent and re-runnable.
  - `node --check` the extracted `<script>` blocks.
  - Confirm the page's `BUILD` constant after the deploy.
- **Showing the user things:**
  - `SendUserFile` with `render` for PNG mockups and screenshots (made-up data plus a ribbon).
  - Interactive private mockup pages were liked.
  - `AskUserQuestion` with a "(Recommended)" first option for real forks; they always picked the recommendation.
- **Compaction:** each summary restated the user's constraints verbatim, an "awaiting explicit yes" list, pending tasks, file paths and the next step. When the summary and the file on disk disagree, the file wins.
- **Classifier boundary:** the environment refused to pull decrypted (or encrypted) user data dumps into the session. Comparisons of private data run inside Actions; real figures appear only in the unlocked page.

## Privacy and security playbook (what actually kept the data private on a public repo)

1. **Encrypt every file the relay publishes** with AES-256-GCM.
   - Key = PBKDF2-SHA256(passphrase, salt, 600k rounds, 64 bytes): the first 32 bytes are the AES key, the rest a token.
   - Envelope `{"lock":1,"t":ms,"iv","ct"}`: same file name, still JSON, only `t` readable.
   - `lock.json` holds the salt, the iteration count and `check`, a sealed known string. A wrong passphrase must stop the pass, never reseal the cumulative files under a new key.
   - The page asks for the passphrase once per device and derives the same key with WebCrypto.
2. **A sealed inbox for private inputs.**
   - An X25519 key pair is derived from the deck key: HKDF-SHA256 with info `'kt-inbox-x25519'` gives the private seed. Only the public key is published.
   - Anyone can seal to it: ephemeral X25519 → ECDH → HKDF(salt = ephemeral public key, info `'kt-inbox'`) → AES-256-GCM, as `{"inbox":1,"epk","iv","ct"}`.
   - Use it for wallets the owner adds, position IDs to check, exchange deposit addresses: anything that would otherwise sit in a public workflow input, commit or file.
   - The seal script refuses to print if the plaintext shows up in its output.
3. **Sealed logs.** `quietLogs()` swaps out `console.*`.
   - The full log is sealed into a file.
   - The public job log gets the line count, the error count, and each error's category: the first word, letters only. Even eight characters of an address in an error message is too much.
   - Plus step timings (step names and seconds only).
4. **Audits and probes print only:**
   - pass/fail;
   - counts and ratios;
   - dates and minutes;
   - market data, tickers and colours.

   They never print an amount, an address, an ID or a share, or say which pools are the owner's. Their messages say "the position you harvested", never its number.
5. **Clean the history once, then guard it.**
   - Before the lock existed, plaintext copies were wiped from every branch's history, and the old Actions runs and logs deleted.
   - A leak-check job now scans every branch, every version of every file, commit messages and logs.
   - A prune job deletes old runs.
6. **Low profile:**
   - the repository has a bland cover README ("internal telemetry utilities");
   - the site root is a blank "nothing to see here" page;
   - the dashboard lives in an unguessable folder, with `<meta name="robots" content="noindex, nofollow">` and `<meta name="referrer" content="no-referrer">`;
   - the worker's responses carry `x-robots-tag: noindex`.

   Obscurity is only an extra layer: the encryption is what protects the data.
7. **Session hygiene:**
   - Never pull decrypted (or even encrypted) data dumps into the Claude session.
   - Never paste secret values.
   - Never put private values in commit messages, workflow inputs (they're echoed in the log's env block), or file names.
   - Verify the user's own private items through sealed requests and yes/no answers.

## Reference handout (moved to docs/handout.md)

The long reference parts of this handout live in `docs/handout.md`, word for word: read the section you need before working on that area.

- Architecture: an always-on system built from GitHub plus one Cloudflare Worker
- On-chain facts and decoding (copy-ready)
- Data sources (public endpoints the code uses)
- Deeper details: always-on, on-chain and data sources
- Accounting rules for LP fees, positions and portfolios
- Analytics worth reusing in a scanner
- Testing, audits and verification
- GitHub Actions / Pages gotchas
- Bugs hit → root cause → fix
- Design lessons from the dashboard
- Starter plan for the pool / liquidity scanner (what to reuse, in order)
- Reusable snippets (condensed from the working code; no dependencies)
- Ideas the user liked but never had built (candidates for the scanner)
- Timeline of the old project (2026)
