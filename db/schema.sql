-- The permanent history archive in Cloudflare D1 (docs/DATA.md "D1 archive", docs/briefs/SQL-plan.md part 1).
-- Market data only, plain so SQL can read it: the rows history.json already holds. Never an owner field, a wallet
-- or a key. Versioned migrations: each "-- migration: N" block runs once, in order (lib/d1.mjs migrate, recorded in
-- schema_migrations). Never edit a block that has run: add the next one. Statements end with ";" at a line's end.
-- Nothing is ever overwritten (lib/d1.mjs): a row changes only from a worse source to a better one, or a null gains a
-- value. Missing is null, never 0. Times: *_at are unix seconds; day_utc is 'YYYY-MM-DD'; hour is the UTC hour's
-- start in hours since 1970 (seconds / 3600). Tables are WITHOUT ROWID: no second index, one row written a row.

-- migration: 1
CREATE TABLE IF NOT EXISTS pools (
  pool_key INTEGER PRIMARY KEY,   -- a short key for pool_hour (hours are about 24 times the day rows)
  pool_id TEXT NOT NULL UNIQUE,   -- v3 pool address or v4 pool id, lowercase hex (history.json's key)
  chain TEXT,                     -- 'ethereum' | 'base'
  dex TEXT,                       -- 'uniswap' | 'pancakeswap'
  version INTEGER,                -- 3 | 4
  fee_tier REAL,                  -- fraction, e.g. 0.003 (a v4 dynamic-fee pool: its fee when first written)
  token0 TEXT, token1 TEXT,       -- token addresses, lowercase
  symbol0 TEXT, symbol1 TEXT,
  created_at INTEGER,             -- the pool's creation, unix seconds (null = not known)
  written_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pool_day (
  pool_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,          -- the UTC day, 'YYYY-MM-DD'
  fees_usd REAL,                  -- the day's LP fees in USD, valued at the day's prices
  fees_src TEXT,                  -- 'e' estimated (volume x rate) < 'x' exact (fee counters) < 's' exact (the day's swaps)
  fees_rank INTEGER NOT NULL DEFAULT 0,   -- 0 = unread, e 1, x 2, s 3
  fees_unconfirmed INTEGER,       -- 1 = a fee spike the day's swaps or volume don't back (history.json u.y); null with no fees
  volume_usd REAL,
  volume_src TEXT,                -- 'g' GeckoTerminal's day candle < 's' the day's swaps
  volume_rank INTEGER NOT NULL DEFAULT 0, -- 0 = unread, g 1, s 2
  tvl_usd REAL,                   -- what the pool holds at the day's end, at that day's prices
  tvl_src TEXT,                   -- 'r' recorded | 'b' balances at an archive block | 'm' the liquidity map: one reading a day
  tvl_rank INTEGER NOT NULL DEFAULT 0,    -- 0 = unread, 1 = read (the first reading stays)
  price REAL,                     -- token1 per token0 at the day's end (the daily row in the next day's first hour)
  lp_fee_rate REAL,               -- fee tier x the share LPs keep, as known when first written
  revisions INTEGER NOT NULL DEFAULT 0,   -- times a better source replaced a field (or a null gained a value)
  written_at INTEGER NOT NULL,
  revised_at INTEGER,
  PRIMARY KEY (pool_id, day_utc)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pool_hour (
  pool_key INTEGER NOT NULL,      -- pools.pool_key
  hour INTEGER NOT NULL,          -- the UTC hour's start, hours since 1970
  sec INTEGER NOT NULL,           -- the row's own time: seconds into the hour (a pass time or a backfilled block's)
  span_s INTEGER,                 -- fees_usd covers the span_s seconds up to the row (null: no row before it)
  fees_usd REAL,                  -- LP fees from the row before (fee counters x the interval's liquidity), at the prices of the pass that first wrote it
  fees_rank INTEGER NOT NULL DEFAULT 0,   -- 0 = unread, 1 = read
  price REAL,                     -- token1 per token0
  liquidity REAL,                 -- the pool's active liquidity
  parked REAL,                    -- 0..1, the share of value parked away from the price
  revisions INTEGER NOT NULL DEFAULT 0,
  written_at INTEGER NOT NULL,
  PRIMARY KEY (pool_key, hour)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,             -- 'sweep' (v = the day of the daily sweep, n = the next pool group), 'w:YYYY-MM-DD' (n = rows written that day)
  v TEXT,
  n INTEGER
) WITHOUT ROWID;

-- migration: 2
-- valued: how the day's USD figures were valued when written. 1 = at the day's own prices (the candle's close within 3
-- days, GeckoTerminal's base token known): a fact, frozen. 0 = at the prices of the pass that wrote it (no close yet):
-- kept as first written, and replaced only by the same source valued at the day's close. NULL = written before this
-- migration (treated as 0).
ALTER TABLE pool_day ADD COLUMN valued INTEGER;
