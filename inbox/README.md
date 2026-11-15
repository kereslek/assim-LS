# Sealed requests for the loop

Files here are sealed to `lock/inbox.json` (X25519): only the loop, which holds the lock, can open them.
The owner's dashboard makes them (Guests: add or remove a guest). The loop reads this folder at the
tip of the code branch every pass and applies each request once (`lib/guests.mjs`). Keep the files: they
are sealed, and replaying them gives the same result.
