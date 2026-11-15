# Guest access, recovery key, passphrase change (owner's yes, 15 Nov 2026)

**What this covers:**
- **Guests:** friends get a guest passphrase that the owner can take back. They see all market data and every view (charts, History, Compare, Pair, the workspace, search). They get no favourites, notes, settings or anything of the owner's. Signals: mockups A, B, D and E, plus a calm "ended" screen. Violet (`#B39DFF`) is used only for guest signals.
- **Owner additions** (after the passphrase was briefly lost on 15 Nov):
  - a recovery key;
  - a safe passphrase change;
  - a mismatch alarm.

This file is public, like the repo: it describes shapes and flows only.

## 1 · Keys: two data keys behind one master key

| Key | What it is | Who holds it |
|---|---|---|
| **Market key (MDEK)** | 32 random bytes. It seals `live.json`, `history.json` and `backtest.json`. | The owner and every guest, through their slots. |
| **Private key (PDEK)** | 32 random bytes. It seals `snapshots.json`, `log.json`, `owner.json` and `guests.json`. | The owner only. |
| **Master key (MK)** | 32 random bytes. It wraps both data keys and the inbox seed. | Whoever opens an owner slot or the recovery slot. |
| **Passphrase key** | PBKDF2-SHA256(passphrase, `lock.json` salt, 600k): the first 32 bytes. | The owner's devices; the loop (`LOCK_PASSPHRASE`). |
| **Recovery key** | 160 random bits, shown as 8 groups of 4 (base32). PBKDF2 with its own salt `rsalt`. | Written down by the owner, kept at home. |
| **Guest key** | PBKDF2(guest passphrase, the shared guest salt `gsalt`, 600k). | That guest's devices; the loop (to re-wrap after a rotation). |

**`keys.json`** sits on the data branch, readable like `lock.json`:

```
{ keys: 2, t, iter, gsalt, rsalt, owner: [Slot], recovery: Slot|null, mk: Slot, slots: [Slot] }
Slot = { iv, ct }   AES-256-GCM over JSON, its kind bound as additional data
  owner slot    under a passphrase key      { m: MK }
  recovery slot under the recovery key      { m: MK }
  master slot   under MK                    { k: MDEK, p: [older MDEKs], pk: PDEK, pp: [older PDEKs], tk: inbox seed, g }
  guest slot    under a guest key           { k: MDEK, s: slot id, n: name, e: expiry, g }
```

- **What a reader without a key learns:** the number of owner slots (1–4), whether a recovery key exists, and the number of guest slots. Slots are shuffled at every write.
- **What a passphrase change touches:** it adds or drops an owner slot. No file is sealed again, and the private key stays the same.
- **What a guest's removal touches:** it replaces the market key, and only the market files are sealed again.
- **What the migration keeps (the first run with slots):**
  - the lock's own key, as the oldest private key (`pp`), so every older file and backup still opens;
  - the lock's token, as the inbox seed (`tk`), so `lock/inbox.json` and `lock/config.sealed.json` don't change.
- **Whatever holds the lock** (`openLock`, `lib/lock.mjs`) gets the vault from `keys.json`: `aes` is the private key, `token` the inbox seed. So the scan, the backtest and the log code stay as they were.
- **When a passphrase counts:** once `keys.json` exists, only an owner slot makes a passphrase valid, and `lock.json`'s check no longer decides. Before that, the check decides, as before.

## 2 · Which file is which (the private audit)

| File | Sealed under | What's in it | Why |
|---|---|---|---|
| `live.json` | market key | Pools, windows, pairs, the market strip, discovery, chains, health counts. | Market data, plus counts the public logs print anyway. |
| `history.json` | market key | Each pool's rows, and the passes' health rows. | Market data. |
| `backtest.json` | market key | Simulated backtests of the top pools. | Simulations, not positions. `realCheck` counts the pool's own positions. |
| `owner.json` *(new)* | private key | `ticket`, `stopLoss`, `gemAt`, `ageDays`. | The owner's settings. |
| `guests.json` *(new)* | private key | Guest labels, expiry, status and keys; finished request ids; the passphrase change's state (`vault`). | Only the owner manages access. |
| `snapshots.json`, `log.json` | private key | Loop state and the sealed log. | Owner only. |
| `keys.json` *(new)* | (its slots are sealed) | Wrapped keys. | Public: slot counts only. |
| `status.json` *(new)* | readable | `{"lock":"mismatch","since":<ms>}`, and only while the loop is paused. | The alarm (§9). |

**Where the split happens:** in `lib/store.mjs`, so no caller can forget it.
- **Writing `live.json`:** `ticket`, `stopLoss` and `gemAt` move into `owner.json`. The token-age label "tokens ranked and trading N+ days" becomes "tokens ranked and trading long enough", and N goes into `owner.json`.
- **Writing `backtest.json`:** `ticket` is dropped (it's the same value).
- **Reading:** `get()` merges everything back.
- **Publishing:** `publish-data` refuses to publish a market file that still carries an owner-only field.
- **Before the migration:** everything is sealed and shaped exactly as before.

**What a guest can still work out:** the market numbers are computed at the owner's ticket and settings.
- Fee APR = 365·F ÷ (V + ticket) and the backtest's dollars let a guest back out the ticket. `gemFirstAt` hints at the gem threshold.
- Hiding this fully needs a second scoring of every pool at a public $1,000 ticket (a later step; the owner's yes).
- A guest's page shows "$ a day" for a public $1,000 example, as in mockup A, and never shows the owner's ticket, stop-loss or threshold.

## 3 · Adding a guest (owner's page, Settings → Guests)

1. Enter a name and an expiry: 7, 30 or 90 days, or none.
2. **The page makes a passphrase:** 5 words from an embedded 1,024-word list plus 2 digits (56.6 bits).
3. **It wraps the market key into a guest slot:** it opens the master slot for the market key, then derives the guest key with `gsalt`.
4. **It seals a request** to the inbox key (X25519 → HKDF → AES-GCM, as `lib/inbox.mjs`): `{ lps: "guest-add", id, at, slot, kek, name, exp, wrap }`.
5. **It shows the passphrase once**, with Copy.
6. **"Send to the loop"** opens GitHub's new-file page with `inbox/<id>.json` already filled in on the code branch. The owner taps **Commit changes**. "Copy the sealed request" is the fallback.
7. **The loop picks it up:** every pass it reads `inbox/` at the code branch's tip. The inbox isn't pinned, so no re-pin is needed. It checks that `wrap` opens with `kek` to a current market key, adds the slot, and records the guest. This takes about one pass (about 6 minutes).

## 4 · Removing a guest, expiry, rotation

- **Remove guest** sends `guest-remove`; **Remove all guests** sends `guest-reset`. Expired guests go the same way, automatically.
- **The loop then:**
  1. drops the slot;
  2. makes a new market key (the master slot keeps the old one in `p`);
  3. seals the market files again;
  4. rebuilds the remaining guests' slots.
- **A guest slot that no live guest opens** (a "stray") also rotates the key away.
- **Requests run once each, in time order,** and replaying them gives the same result. Keep the files in `inbox/`.
- **The removed guest's device** then shows "Your guest access has ended".
- **What a guest already saw can't be recalled.** Removal stops new data only.

## 5 · Migration (the loop's first run on this code)

1. **Before:** a `backup.yml` run, and the v0.7.0 page deployed (it reads both formats).
2. **At the loop's start:** the loop restores the data branch. Only if the branch was read and has no `keys.json`, it:
   - creates MK, MDEK, PDEK and `gsalt`, and the first owner slot from `LOCK_PASSPHRASE`;
   - re-seals the restored files (market files under MDEK with the owner-only fields split off; `snapshots`/`log` under PDEK);
   - from then on holds the vault itself.
3. **The first publish** carries `keys.json` and every file in one verified commit.
4. **Owner devices keep working with no re-unlock:** the stored key opens the owner slot. After that the device also keeps MK, so later passphrase changes never lock it out.
5. **The live audit's unlock** (`LOCK_PASSPHRASE`) works the same way.
6. **Rollback:** an older pinned loop refuses the new files. Rolling back means restoring the pre-migration backup together with the old pin.

## 6 · The guest page

- **Unlock:** the passphrase is derived with the lock salt and with `gsalt` at the same time. The page tries the owner slots, then the guest slots.
  - A guest device keeps only its guest key (non-extractable, IndexedDB).
  - Each refresh opens the slot for the market key.
- **Never fetched for guests:** `owner.json` and `guests.json`. They're under the private key and wouldn't open anyway.
- **Disabled with message D:** ★ (with a violet lock badge), Favourites, the Settings panel, and "Needs you". Message D: "Saving isn't on for guests. Ask the admin for your own login." Sign out stays.
- **Signals:**
  - **A:** a "GUEST · name" pill by the version badge, with a sheet: ends <date>, can / can't, Done.
  - **B:** a 3 px violet top line on every screen.
  - **D:** the locked ★.
  - **E:** a one-time welcome card.
  - **Ended:** "Your guest access has ended" with "Use a different passphrase".

## 7 · Safety

- **A passphrase that opens nothing stops everything** before anything is read or sealed.
- **Never a second `keys.json`:**
  - a process that already holds the vault never makes keys again;
  - a data branch with a different guest salt is refused.
- **No migration while the data branch is unread.**
- **One commit, verified before the push:**
  - each market file opens with the current market key and carries no owner-only field;
  - each private file opens with the private key;
  - each live guest opens exactly their slot.
  - A file left under an older key (e.g. a backtest published mid-rotation) is sealed again under the current one.
- **Older keys stay in the master slot** (two of each), so nothing becomes unreadable for the owner.
- **No tags are made.** The hourly sealed backups cover a bad rotation.
- **Public logs print counts and yes/no only.**
- **A request's authority is repo write access.** The sealing keeps its content private. A forged owner or recovery slot can't hold the real master key, so it opens nothing.

## 8 · Recovery key and a safe passphrase change

- **Create a recovery key** (Settings → Recovery key → Create):
  1. The page makes 160 random bits, shown once as `XXXX-XXXX-…` (base32, 8 groups), with "Write this down and keep it at home".
  2. It asks for two of its groups back.
  3. It then wraps MK under PBKDF2(key, a new `rsalt`, 600k) and sends `{ lps: "recovery-set", rsalt, slot }` the same way. A new key replaces the old one.
- **Use the recovery key** (unlock screen → "Use recovery key"): it opens MK, so everything opens. The page then walks straight into a passphrase change.
- **Change the passphrase** (Settings → Passphrase → Change, or after a recovery):
  1. The page wraps MK under the new passphrase's key and sends `{ lps: "owner-add", slot }`.
  2. Once the loop adds it ("new passphrase ready": both passphrases now open), the page shows the exact steps to update the GitHub secret `LOCK_PASSPHRASE`.
  3. The first pass the loop runs on the new secret drops every other owner slot, and the page says "done".
  4. Devices keep working throughout: they hold MK.
- **What a change does and doesn't revoke:** it isn't a response to a leaked passphrase. The old passphrase still opens older backups and the inbox (whose requests never carry a passphrase key or MK). A full key rotation is a separate, later step.

## 9 · The mismatch alarm

If `LOCK_PASSPHRASE` opens no owner slot, the loop stops before opening or sealing anything, and writes `out/loop/alarm` = `mismatch`. The workflow's alarm step (`scripts/alarm.mjs`, `issues: write` in `loop.yml` only) then:
- **Adds the flag:** `status.json` (`{"lock":"mismatch","since":<ms>}`) goes onto the data branch. Every other file stays byte for byte.
- **Shows a banner:** every page shows a red banner, locked or unlocked: "The scanner is paused: the passphrase in GitHub doesn't match your data. Nothing is lost." It comes with the fix steps.
- **Opens one issue,** "Scanner paused: passphrase mismatch" (no details), and leaves it alone on later runs.
- **Clears itself:** the first pass that opens publishes without the flag, and the alarm step closes the issue.

## 10 · Tests

- **Unit tests** (`test/guest*.test.mjs`), made-up data only:
  - slots and kinds;
  - the private split;
  - migration that keeps every row;
  - add, remove, expiry, stray slots and rotation;
  - the recovery key opening both data keys;
  - a passphrase change that keeps old and new valid until the drop;
  - a passphrase that opens nothing stopping everything;
  - the flag published with every other file unchanged, and cleared by the next good publish;
  - one issue, not one per run;
  - backup and the drill reading `keys.json`;
  - requests read from `inbox/`.
- **Site tests:**
  - groups `guest`, `guestend`, `recovery`, `passchange` and `mismatch`, all in v0.7.0 (they fit naturally: one key structure).
  - Every new check fails on `site/app/index.html`.
