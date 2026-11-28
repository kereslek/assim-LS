# SQL store plan (owner's picks, 14 Nov 2026) — part 1 built; part 2's read API built

Status: **part 1 built** (22 Nov 2026): the permanent history archive in D1 (`assim-ls-archive`, `db/schema.sql`, `lib/d1.mjs`, the jobs in `.github/workflows/d1.yml`, the loop's writer in `scripts/scan.mjs`; docs/DATA.md "D1 archive"). It goes live in the loop when `loop/PIN` moves to the commit that has it. Built differently from the plan: the loop writes D1 directly through its REST API with the Actions secrets (no Worker yet; the Worker comes with part 2), and the sealed yearly copy on GitHub is not built yet (the data and backup branches keep `history.json`'s year meanwhile). Parts 3 to 5: plan only, after mockups.

Part 2 status: **the read API built** (23 Nov 2026), for the owner's archive picks **A** (History ranges to ALL, an hourly zoom on any past week) and **C** ("Find days" presets): the Worker `assim-ls-api` (`worker/`, deployed by `.github/workflows/worker.yml` through the REST API, on the account's workers.dev subdomain) reads D1 read-only: `/v1/meta`, `/v1/days`, `/v1/hours` (8 days a call), `/v1/find` (`spikes10x`, `doubled`, `quietest`, `outliers`, the page's standout rule in SQL). Logins as built: no password reaches the Worker; each role's page derives a bearer token after unlock from what its key slot opened (`lib/apitoken.mjs`: an HMAC under the private key for the owner, under the market key with the slot's id for a guest or member), and the Worker keeps only SHA-256 hashes with role and end in KV `assim-ls-auth`, which the loop keeps in sync with the key slots (`lib/apiauth.mjs`: a removed or expired guest's hash goes at once). Rate limits per token hash; CORS for the dashboard only (docs/DATA.md "Archive API"). It goes live in the loop when `loop/PIN` moves to the commit that has the sync. The page side: candidate **v0.8.3** (28 Nov 2026), the owner's **A + C + F** in History: All reaches the archive's older days, an hourly zoom on any past week (‹ › a week), the "Find days" presets (a row opens that pool's History on that day), and **F**, "~" on a big day the volume backs only part of, with the plain words ("volume backs 51%": the day's volume × the pool's fee rate accounts for only 51% of the fees counted, so the spike is real but its size may be smaller); the token derived after unlock as `lib/apitoken.mjs` does, in memory only; the CSP's `connect-src` gains exactly the Worker's origin; the archive unreachable, refusing or null shows "—" or "archive unavailable" and History works as before (site-test group `archive`, made-up answers). Not built yet: the guest write refusal (403 `guest_readonly`) and owner items, which come with parts 3 and 4: the API has no write route at all.

## Owner's decisions
- Platform: **Cloudflare D1 + one Worker** (free plan). Supabase not used.
- Guests see **market data only**: pools, gems, charts, history. Never the owner's favourites, comments, or future positions and wallets.
- Guest access: **one shared guest password**, changeable at any time (changing it locks every guest out).
- Comments and day notes: **owner only**, encrypted on the device (Cloudflare sees ciphertext only).
- Guest save message, word for word: *"Saving isn't enabled for guest users yet. Ask the admin for your own database password."* It is enforced by the Worker (403 `guest_readonly`), not only by the page.
- The permanent history archive goes ahead (owner agreed to all recommendations).

## Parts
1. **History archive** (D1 table of daily rows per pool: fees + source, volume + source, TVL + source, price). The loop writes it once a UTC day through the Worker, using a write secret held in Actions secrets. A one-time import from history.json runs inside Actions. A sealed yearly copy is also kept on GitHub as a backup. Nothing is ever overwritten.
2. **Logins and roles**: admin (owner), user (later), guest. The passphrase → PBKDF2 split already yields a token half; the Worker keeps only hashes of each role's token. Sessions are short, logins are rate-limited, and the Worker never logs a secret.
3. **Keys**: market data and owner-private data get **separate keys**. The guest password unwraps only the market key. Rotating the guest password re-wraps that key; a full rotation re-seals the data.
4. **Owner items**: favourites synced between iPhone and laptop (local stars migrate once), a comment per pool, and a note per History day. All are encrypted client-side, with an encrypted export button as the owner's own copy.
5. **Users**: later, only on the owner's say.

## Owner-only steps (paste-ready list to be given at build time)
Cloudflare account → D1 database → API token (D1 + Workers edit) → two GitHub Actions secrets (account id, token). About 10 minutes.

## Open
- Privacy: market rows in D1 are plain (public data, behind login, not published) so SQL queries work; owner-private rows are ciphertext.
