# SQL store plan (owner's picks, 14 Nov 2026) — planned, not built

Status: **plan only**. Build starts on the owner's go, after the owner's one-time Cloudflare steps.

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
