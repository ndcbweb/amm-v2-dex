import { ENV } from "./config.js";
import { q } from "./db.js";
import { getSettings } from "./settings.js";

const DAY = 86_400;
const HOUR = 3_600;
const now = () => Math.floor(Date.now() / 1000);

function loadPairs() {
  return q(
    `SELECT p.address, p.idx, p.token0, p.token1, p.reserve0, p.reserve1, p.swaps, p.created_time AS createdTime,
            t0.symbol AS symbol0, t0.name AS name0, t0.decimals AS d0,
            t1.symbol AS symbol1, t1.name AS name1, t1.decimals AS d1
     FROM pairs p JOIN tokens t0 ON t0.address = p.token0 JOIN tokens t1 ON t1.address = p.token1`
  )
    .all()
    .map((row) => ({
      ...row,
      r0: Number(BigInt(row.reserve0)) / 10 ** row.d0,
      r1: Number(BigInt(row.reserve1)) / 10 ** row.d1,
    }));
}

/**
 * Prices every token in the native coin by walking pools outward from the wrapped native token,
 * always trusting the deepest pool that links a token to an already-priced one.
 */
function priceTokens(pairs) {
  const prices = new Map([[ENV.wnative, 1]]);
  const depth = new Map([[ENV.wnative, Infinity]]);
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const pair of pairs) {
      if (!(pair.r0 > 0 && pair.r1 > 0)) continue;
      for (const [known, other, rKnown, rOther] of [
        [pair.token0, pair.token1, pair.r0, pair.r1],
        [pair.token1, pair.token0, pair.r1, pair.r0],
      ]) {
        if (!prices.has(known) || depth.get(other) === Infinity) continue;
        const liquidity = rKnown * prices.get(known);
        if (liquidity > (depth.get(other) ?? 0)) {
          prices.set(other, liquidity / rOther);
          depth.set(other, liquidity);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return prices;
}

function pairValue(pair, prices) {
  const p0 = prices.get(pair.token0);
  const p1 = prices.get(pair.token1);
  if (p0 != null && p1 != null) return pair.r0 * p0 + pair.r1 * p1;
  if (p0 != null) return 2 * pair.r0 * p0;
  if (p1 != null) return 2 * pair.r1 * p1;
  return null;
}

function volumeValue(volume0, volume1, pair, prices) {
  const p0 = prices.get(pair.token0);
  const p1 = prices.get(pair.token1);
  if (p0 != null && p1 != null) return (volume0 * p0 + volume1 * p1) / 2;
  if (p0 != null) return volume0 * p0;
  if (p1 != null) return volume1 * p1;
  return null;
}

let cache = { at: 0, value: null };

export function snapshot() {
  if (cache.value && Date.now() - cache.at < 4000) return cache.value;
  const settings = getSettings();
  const pairs = loadPairs();
  const prices = priceTokens(pairs);
  const stablePrice = settings.stableToken ? prices.get(settings.stableToken) : null;
  const nativeUsd = stablePrice ? 1 / stablePrice : null;

  const since24 = now() - DAY;
  const since48 = now() - 2 * DAY;
  const since7d = now() - 7 * DAY;
  const volumes = new Map();
  for (const row of q(
    `SELECT pair,
            SUM(CASE WHEN hour >= ? THEN volume0 ELSE 0 END) AS v0d, SUM(CASE WHEN hour >= ? THEN volume1 ELSE 0 END) AS v1d,
            SUM(CASE WHEN hour >= ? AND hour < ? THEN volume0 ELSE 0 END) AS v0p, SUM(CASE WHEN hour >= ? AND hour < ? THEN volume1 ELSE 0 END) AS v1p,
            SUM(volume0) AS v0w, SUM(volume1) AS v1w,
            SUM(CASE WHEN hour >= ? THEN swaps ELSE 0 END) AS swaps24
     FROM pair_hours WHERE hour >= ? GROUP BY pair`
  ).all(since24, since24, since48, since24, since48, since24, since24, since7d)) {
    volumes.set(row.pair, row);
  }

  const enriched = pairs.map((pair) => {
    const v = volumes.get(pair.address) || {};
    const tvl = pairValue(pair, prices);
    return {
      address: pair.address,
      idx: pair.idx,
      token0: { address: pair.token0, symbol: pair.symbol0, name: pair.name0, decimals: pair.d0 },
      token1: { address: pair.token1, symbol: pair.symbol1, name: pair.name1, decimals: pair.d1 },
      reserve0: pair.reserve0,
      reserve1: pair.reserve1,
      reserve0Float: pair.r0,
      reserve1Float: pair.r1,
      price0: pair.r0 > 0 ? pair.r1 / pair.r0 : null,
      price1: pair.r1 > 0 ? pair.r0 / pair.r1 : null,
      tvl,
      volume24h: volumeValue(v.v0d || 0, v.v1d || 0, pair, prices),
      volumePrev24h: volumeValue(v.v0p || 0, v.v1p || 0, pair, prices),
      volume7d: volumeValue(v.v0w || 0, v.v1w || 0, pair, prices),
      swaps24h: v.swaps24 || 0,
      swaps: pair.swaps,
      createdTime: pair.createdTime,
    };
  });

  const value = { pairs: enriched, prices, nativeUsd, raw: pairs };
  cache = { at: Date.now(), value };
  return value;
}

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);

export function overview() {
  const { pairs, nativeUsd, raw, prices } = snapshot();
  const days = 30;
  const start = Math.floor(now() / DAY) * DAY - (days - 1) * DAY;
  const byPair = new Map(raw.map((pair) => [pair.address, pair]));

  const baseline = new Map();
  for (const row of q(
    `SELECT h.pair, h.reserve0, h.reserve1 FROM pair_hours h
     JOIN (SELECT pair, MAX(hour) AS hour FROM pair_hours WHERE hour < ? GROUP BY pair) last
       ON last.pair = h.pair AND last.hour = h.hour`
  ).all(start)) {
    baseline.set(row.pair, row);
  }
  const series = Array.from({ length: days }, (_, i) => ({ day: start + i * DAY, volume: 0, tvl: 0 }));
  const reserves = new Map(baseline);
  const hours = q("SELECT pair, hour, reserve0, reserve1, volume0, volume1 FROM pair_hours WHERE hour >= ? ORDER BY hour").all(start);
  let cursor = 0;
  for (const point of series) {
    const end = point.day + DAY;
    for (; cursor < hours.length && hours[cursor].hour < end; cursor += 1) {
      const row = hours[cursor];
      const pair = byPair.get(row.pair);
      if (!pair) continue;
      reserves.set(row.pair, row);
      point.volume += volumeValue(row.volume0, row.volume1, pair, prices) || 0;
    }
    for (const [address, row] of reserves) {
      const pair = byPair.get(address);
      if (pair) point.tvl += pairValue({ ...pair, r0: row.reserve0, r1: row.reserve1 }, prices) || 0;
    }
  }

  const volume24h = sum(pairs, "volume24h");
  const volumePrev24h = sum(pairs, "volumePrev24h");
  const tvl = sum(pairs, "tvl");
  return {
    tvl,
    volume24h,
    volumeChange: volumePrev24h > 0 ? (volume24h - volumePrev24h) / volumePrev24h : null,
    volume7d: sum(pairs, "volume7d"),
    swaps24h: sum(pairs, "swaps24h"),
    pairCount: pairs.length,
    tokenCount: q("SELECT COUNT(*) AS n FROM tokens").get().n,
    nativeUsd,
    series,
  };
}

export function tokens() {
  const { pairs, prices, nativeUsd } = snapshot();
  const map = new Map();
  for (const pair of pairs) {
    for (const [token, reserve] of [
      [pair.token0, pair.reserve0Float],
      [pair.token1, pair.reserve1Float],
    ]) {
      const entry = map.get(token.address) || { ...token, price: prices.get(token.address) ?? null, tvl: 0, volume24h: 0, pairs: 0 };
      entry.pairs += 1;
      if (entry.price != null) entry.tvl += reserve * entry.price;
      if (pair.volume24h) entry.volume24h += pair.volume24h;
      map.set(token.address, entry);
    }
  }
  const dayAgo = now() - DAY;
  for (const entry of map.values()) {
    entry.priceUsd = entry.price != null && nativeUsd ? entry.price * nativeUsd : null;
    entry.priceChange24h = priceChange(entry.address, dayAgo, entry.price);
  }
  return { tokens: [...map.values()].sort((a, b) => b.tvl - a.tvl), nativeUsd };
}

/** Change against the deepest native-quoted pool's closing reserves a day ago. */
function priceChange(token, at, price) {
  if (price == null || token === ENV.wnative) return token === ENV.wnative ? 0 : null;
  const pair = q(
    `SELECT address, token0 FROM pairs WHERE (token0 = ? AND token1 = ?) OR (token0 = ? AND token1 = ?)
     ORDER BY CAST(reserve0 AS REAL) DESC LIMIT 1`
  ).get(token, ENV.wnative, ENV.wnative, token);
  if (!pair) return null;
  const old = q("SELECT reserve0, reserve1 FROM pair_hours WHERE pair = ? AND hour <= ? ORDER BY hour DESC LIMIT 1").get(pair.address, at);
  if (!old || !(old.reserve0 > 0 && old.reserve1 > 0)) return null;
  const then = pair.token0 === token ? old.reserve1 / old.reserve0 : old.reserve0 / old.reserve1;
  return then > 0 ? (price - then) / then : null;
}

export function pairDetail(address) {
  const { pairs, nativeUsd, prices } = snapshot();
  const pair = pairs.find((row) => row.address === address);
  if (!pair) return null;
  const since = now() - 7 * DAY;
  const hours = q("SELECT hour, reserve0, reserve1, volume0, volume1, swaps FROM pair_hours WHERE pair = ? AND hour >= ? ORDER BY hour").all(address, since);
  const raw = { token0: pair.token0.address, token1: pair.token1.address };
  const candles = hours.map((row) => ({
    time: row.hour,
    price: row.reserve0 > 0 ? row.reserve1 / row.reserve0 : null,
    volume: volumeValue(row.volume0, row.volume1, raw, prices),
    swaps: row.swaps,
  }));
  return { pair, candles, nativeUsd, hourSeconds: HOUR };
}

export function events({ pair, account, limit = 50 }) {
  const where = [];
  const args = [];
  if (pair) {
    where.push("e.pair = ?");
    args.push(pair);
  }
  if (account) {
    where.push("e.account = ?");
    args.push(account);
  }
  return q(
    `SELECT e.block, e.log_index AS logIndex, e.pair, e.kind, e.time, e.tx, e.account,
            e.amount0_in AS amount0In, e.amount1_in AS amount1In, e.amount0_out AS amount0Out, e.amount1_out AS amount1Out,
            t0.symbol AS symbol0, t0.decimals AS d0, t1.symbol AS symbol1, t1.decimals AS d1, p.token0, p.token1
     FROM events e JOIN pairs p ON p.address = e.pair
       JOIN tokens t0 ON t0.address = p.token0 JOIN tokens t1 ON t1.address = p.token1
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY e.block DESC, e.log_index DESC LIMIT ?`
  ).all(...args, limit);
}
