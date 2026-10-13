import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ENV } from "./config.js";

export const db = new DatabaseSync(join(ENV.dataDir, "index.db"));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pairs (
  address TEXT PRIMARY KEY,
  idx INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  created_block INTEGER NOT NULL,
  created_time INTEGER NOT NULL,
  reserve0 TEXT NOT NULL DEFAULT '0',
  reserve1 TEXT NOT NULL DEFAULT '0',
  swaps INTEGER NOT NULL DEFAULT 0
);

-- Swaps, adds and removes. Raw amounts are exact strings; *_f are decimal-adjusted for analytics.
CREATE TABLE IF NOT EXISTS events (
  block INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  pair TEXT NOT NULL,
  kind TEXT NOT NULL,
  time INTEGER NOT NULL,
  tx TEXT NOT NULL,
  account TEXT,
  amount0_in TEXT NOT NULL DEFAULT '0',
  amount1_in TEXT NOT NULL DEFAULT '0',
  amount0_out TEXT NOT NULL DEFAULT '0',
  amount1_out TEXT NOT NULL DEFAULT '0',
  volume0 REAL NOT NULL DEFAULT 0,
  volume1 REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS events_pair ON events (pair, block DESC);
CREATE INDEX IF NOT EXISTS events_time ON events (time);

-- Hourly candles per pair: closing reserves and swap volume, both decimal-adjusted.
CREATE TABLE IF NOT EXISTS pair_hours (
  pair TEXT NOT NULL,
  hour INTEGER NOT NULL,
  reserve0 REAL NOT NULL,
  reserve1 REAL NOT NULL,
  volume0 REAL NOT NULL DEFAULT 0,
  volume1 REAL NOT NULL DEFAULT 0,
  swaps INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pair, hour)
);
`);

const statements = new Map();
export function q(sql) {
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

export function getMeta(key, fallback = null) {
  return q("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? fallback;
}

export function setMeta(key, value) {
  q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

export function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
