# Guest access with key slots (owner's yes, top priority, 15 Nov 2026)

Friends get a guest passphrase that the owner can take back. Guests see all market data and every view
(charts, History, Compare, Pair, the workspace, search). They get no favourites, notes, settings or anything
of the owner's. Approved signals: mockups A, B, D and E, plus a calm "ended" screen. Violet (`#B39DFF`) is
used only for guest signals.

This file is public, like the repo: it describes shapes and flows only.

## 1 · Keys

| Key | What it is | Who holds it |
|---|---|---|
| **Owner key** | PBKDF2-SHA256(owner passphrase, `lock.json` salt, 600k, 64 bytes): AES key + token (unchanged). | The owner's devices; the loop (`LOCK_PASSPHRASE`). |
| **Data key (DEK)** | 32 random bytes. It seals the **market files** only. | Whoever opens a slot in `keys.json`. |
| **Guest key (KEK)** | PBKDF2-SHA256(guest passphrase, the shared **guest salt**, 600k, 64 bytes): the first 32 bytes. | That guest's devices; the loop (sealed in `guests.json`, to re-wrap after a rotation). |

- **`keys.json`** (data branch, readable, like `lock.json`): `{ keys: 1, t, gsalt, iter, owner: Slot, slots: [Slot] }`, where `Slot = { iv, ct }` is AES-256-GCM.
  - **The owner slot** is sealed under the owner key (additional data `lps-owner-slot`). Inside: `{ k: DEK, p: [the previous DEKs, at most 2], g: generation }`.
  - **A guest slot** is sealed under that guest's KEK (additional data `lps-guest-slot`). Inside: `{ k: DEK, s: slot id, n: name, e: expiry ms or null, g }`.
  - The slots are shuffled at every write and carry nothing readable. **A reader without a key learns only how many slots there are.**
- **One guest salt for all guests:** a phone derives once and tries every slot (each try is one fast AES-GCM check).
- **The unlock form** derives the owner key and the guest key at the same time, then tries the owner check first and the guest slots second.

## 2 · Which file is which (the private audit)

| File | Sealed under | What's in it | Why |
|---|---|---|---|
| `live.json` | **DEK** (market) | Pools, windows, pairs, the market strip, discovery, chains, health counts. | Market data, plus counts that public logs already print. |
| `history.json` | **DEK** | Each pool's hourly/daily/yearly rows, and the passes' health rows. | Market data. |
| `backtest.json` | **DEK** | Simulated backtests of the top pools. | Market data (simulations, not positions). `realCheck` counts the pool's own positions, not the owner's. |
| `owner.json` *(new)* | owner key | `ticket`, `stopLoss`, `gemAt`, `ageDays` (the token-age threshold). | The owner's settings (the sealed config). |
| `guests.json` *(new)* | owner key | Guest labels, expiry, status, their KEKs, finished request ids, the generation. | Only the owner manages guests. |
| `snapshots.json` | owner key | The raw per-pool state the loop recomputes windows from. | Loop state; the page never reads it. |
| `log.json` | owner key | The sealed log. | Logs stay owner-only. |
| `keys.json` *(new)* | (its slots are sealed) | Wrapped DEK copies. | Public: the slot count only. |
| `lock.json` | (readable) | Salt, rounds, check. | Unchanged. |

**The split happens in one place, `lib/store.mjs`**, so no caller can forget it:
- `put('live.json')`, once a DEK exists, moves `ticket`, `stopLoss` and `gemAt` into `owner.json`. It also rewrites the token-age check's label from "tokens ranked and trading N+ days" to "tokens ranked and trading long enough", keeping N in `owner.json`.
- `put('backtest.json')` drops `ticket`: it's the same config value as live's.
- `get()` merges them back, so the loop's code sees the same objects as before.
- `publish-data` refuses to publish a market file that still carries an owner-only field.
- **Until the first migration** (no `keys.json` yet), everything is sealed and shaped exactly as before. That way an older pinned loop, the backtest job and the pools job keep working side by side.

**What a determined guest could still work out (residual inference, stated plainly):**
- The market numbers are computed at the owner's ticket and settings. Fee APR = 365·F ÷ (V + ticket) and the backtest's $ amounts let a guest back out the ticket. `gemFirstAt` hints at the gem threshold.
- Hiding these fully means scoring a second copy of every pool at a public $1,000 ticket for guests. That's a later step and needs the owner's yes.
- The page shows guests no ticket, stop-loss or threshold, and no "$ a day at the ticket".

## 3 · Adding a guest (owner's unlocked page)

1. **Guests → Add guest:** a name, and expiry 7 / 30 / 90 days or none.
2. **The page makes a passphrase:** 5 words from an embedded 1,024-word list plus 2 digits (5 × 10 + 6.6 = 56.6 bits).
3. **It wraps the key:** it opens the owner slot with the stored owner key, derives the guest KEK (600k rounds, guest salt) and wraps the DEK into a guest slot.
4. **It seals a request** to the inbox key (`lock/inbox.json`, X25519 → HKDF → AES-GCM, as `lib/inbox.mjs`):
   `{ lps: "guest-add", id, at, slot, kek, name, exp, wrap }`.
5. **It shows the passphrase once**, with Copy, and a **"Send to the loop"** button. The button opens GitHub's new-file page with the file already filled in (`inbox/<id>.json` on the code branch). The owner taps **Commit changes**; a Copy button is the fallback.
6. **The loop picks it up:** every pass reads `inbox/` at the code branch's tip (the same sealed-to-the-inbox pattern as `lock/config.sealed.json`, but it isn't pinned, so no re-pin is needed). It checks the request (the `wrap` must open with the KEK and hold a current DEK), adds the slot and records the guest in `guests.json`.
7. **A guest can open the page within one pass**, about 6 minutes.

## 4 · Removing a guest, expiry, rotation

- **Remove guest** (owner's page, Guests list) seals `{ lps: "guest-remove", id, at, slot }` and sends it the same way. **Remove all guests** sends `guest-reset`.
- **The loop drops the slot and rotates the DEK** in that same pass:
  1. a new random DEK;
  2. the owner slot holds the new DEK and the old one (`p`);
  3. the market files are re-sealed under the new DEK;
  4. the remaining guests' slots are rebuilt with their KEKs.
- **Expired guests** (expiry ≤ now) go the same way, automatically.
- **Requests are processed once** (their ids go into `guests.json`), in time order, and replay to the same result. Keep the files in `inbox/`: they're sealed, and they're the record.
- **After a removal, the guest's device can't open new data** and shows "Your guest access has ended".
- **What a guest already saw can't be recalled:** data shown or saved before the removal stays with them. Removal stops new data only.

## 5 · Migration (the first loop run on this code)

1. **Before it:** a `backup.yml` run (the release path), and the v0.7.0 page deployed. The page reads both formats.
2. **The loop's start:** after restoring the data branch, and only if the data branch was read and has no `keys.json`, the loop:
   - creates the DEK, the guest salt and the owner slot from `LOCK_PASSPHRASE`;
   - re-seals the restored market files under the DEK, reading the old format, so nothing cumulative is lost;
   - splits out the owner-only fields.
3. **The first publish** carries `keys.json` and the re-sealed files in **one commit**, verified before the push.
4. **Owner devices keep working with no re-unlock:** the page checks the stored owner key against `lock.json` (unchanged), then opens the owner slot for the DEK.
5. **The live audit** (`LOCK_PASSPHRASE`) unlocks the same way.
6. **Rollback:** after the migration, an older pinned loop refuses the new files (`keys.json`, `owner.json`, `guests.json`) and won't publish. Rolling back means restoring the pre-migration backup (`docs/RESTORE.md`) together with the old pin.

## 6 · The guest page

- **Unlock:** the owner check first, then the guest slots (both keys derived at once).
  - The device keeps only the guest KEK, as a non-extractable CryptoKey in IndexedDB, like the owner key today.
  - On each refresh the page reads `keys.json` (the newest copy of all sources) and opens the slot for the DEK.
- **Private parts are never fetched for guests:** `owner.json`, `guests.json`, `snapshots.json` and `log.json` (the last two are never fetched by anyone). They wouldn't open with a guest key anyway.
- **Disabled with message D:** ★ (it keeps a small violet lock badge), favourites, the Guests panel, and anything that saves. Message D: "Saving isn't on for guests. Ask the admin for your own login."
  - "Sign out on this device" stays, so a guest can forget the key.
- **Signals:**
  - **A:** a "GUEST · name" pill by the version badge, which opens a sheet: ends <date>, can / can't, Done.
  - **B:** a 3 px violet line along the top of every screen, the workspace and full view included.
  - **D:** the ★ lock badge and its note.
  - **E:** a one-time "Welcome, name" card.
  - **Ended:** "Your guest access has ended" with "Use a different passphrase". Never an error or a blank page.
- **Everything else is the same as the owner's.** Numbers that are "at the ticket" show as rates only.

## 7 · Safety

- **A wrong passphrase still stops everything** before anything is read or sealed.
- **`keys.json` is never overwritten without its owner slot opening:**
  - A `keys.json` that doesn't open with the lock stops the pass.
  - A data branch whose guest salt differs from the loop's own is refused (that would be a second migration).
- **No migration while the data branch is unread:** a failed restore at the loop's start means no keys step until the next run.
- **One commit, verified before the push:**
  - every market file opens with the DEK that `keys.json`'s owner slot holds, and carries no owner-only field;
  - every owner file opens with the owner key;
  - every live guest slot opens with its KEK.
  - A file sealed under a previous DEK (a backtest published mid-rotation) is re-sealed under the current one before the push.
- **Not readable by the owner can't happen by mistake:** the owner slot always keeps the two previous DEKs.
- **No tags are made:** the loop's publish pattern has none. The hourly sealed backups cover a bad rotation.
- **Public logs** print only counts and yes/no:
  `guests: 2 active, 1 added, 0 removed, 0 expired, 0 refused; data key rotated: no; keys written: yes`.
- **A request's authority is repo write access:** only someone who can commit to the code branch can add or remove guests. The sealing keeps the request's content private.

## 8 · Tests

- **Unit tests** (`test/guest*.test.mjs`), made-up data only:
  - wrap and unwrap;
  - the private split's round trip;
  - migration that keeps cumulative state;
  - add, remove, expiry and rotation;
  - a wrong passphrase stopping;
  - a guest salt mismatch refused;
  - a removed guest locked out of re-sealed files;
  - publish re-sealing a stale file;
  - backup and restore with `keys.json`.
- **Site tests,** groups `guest` and `guestend` (made-up fixtures with owner, guest, removed and expired passphrases):
  - unlock;
  - A, B, D and E;
  - private parts absent;
  - search, History and Compare working;
  - the ended screen;
  - the owner unlocking after migration with no re-unlock.
  - Every new check fails on `site/app/index.html`.
