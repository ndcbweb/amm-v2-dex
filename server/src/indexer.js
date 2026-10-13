import { decodeEventLog, parseAbi, toEventSelector } from "viem";
import { tokenMeta } from "./chain.js";
import { ENV } from "./config.js";
import { getMeta, q, setMeta, transaction } from "./db.js";
import { rpc, rpcBatch } from "./rpc.js";

const FACTORY_EVENTS = parseAbi([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)",
]);
const PAIR_EVENTS = parseAbi([
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
]);
const PAIR_CREATED = toEventSelector(FACTORY_EVENTS[0]);
const PAIR_TOPICS = PAIR_EVENTS.map((item) => toEventSelector(item));
const SYNC_TOPIC = PAIR_TOPICS[0];
const ADDRESSES_PER_QUERY = 500;

export const state = { indexed: -1, chainHead: -1, lastError: "", running: false };

const toFloat = (raw, decimals) => Number(raw) / 10 ** decimals;
const hex = (n) => `0x${n.toString(16)}`;

let chunk = ENV.logChunk;

async function getLogs(filter) {
  return rpc("eth_getLogs", [filter], { timeoutMs: 45_000 });
}

/** eth_getLogs with the range halved whenever the node refuses it (block range or result-size limits). */
async function logsInRange(from, to, build) {
  try {
    return await getLogs(build(from, to));
  } catch (error) {
    if (to <= from) throw error;
    chunk = Math.max(10, Math.floor((to - from + 1) / 2));
    const mid = from + chunk - 1;
    const left = await logsInRange(from, mid, build);
    const right = await logsInRange(mid + 1, to, build);
    return [...left, ...right];
  }
}

const pairCache = new Map();
function loadPairs() {
  if (pairCache.size) return pairCache;
  for (const row of q("SELECT p.address, p.token0, p.token1, t0.decimals AS d0, t1.decimals AS d1 FROM pairs p JOIN tokens t0 ON t0.address = p.token0 JOIN tokens t1 ON t1.address = p.token1").all()) {
    pairCache.set(row.address, row);
  }
  return pairCache;
}

async function blockTimes(numbers) {
  const unique = [...new Set(numbers)];
  const blocks = await rpcBatch(unique.map((n) => ["eth_getBlockByNumber", [hex(n), false]]));
  return new Map(unique.map((n, i) => [n, Number(BigInt(blocks[i].timestamp))]));
}

/** Who signed each transaction; a Swap's `to` is the next pool on multi-hop routes, so it is not the trader. */
async function txSenders(hashes) {
  const unique = [...new Set(hashes)];
  const txs = await rpcBatch(unique.map((hash) => ["eth_getTransactionByHash", [hash]]));
  return new Map(unique.map((hash, i) => [hash, txs[i]?.from?.toLowerCase() || null]));
}

async function indexRange(from, to) {
  const created = await logsInRange(from, to, (a, b) => ({
    address: ENV.factory,
    topics: [PAIR_CREATED],
    fromBlock: hex(a),
    toBlock: hex(b),
  }));
  const newPairs = [];
  for (const log of created) {
    const { args } = decodeEventLog({ abi: FACTORY_EVENTS, data: log.data, topics: log.topics });
    const token0 = args.token0.toLowerCase();
    const token1 = args.token1.toLowerCase();
    const [m0, m1] = [await tokenMeta(token0), await tokenMeta(token1)];
    newPairs.push({
      address: args.pair.toLowerCase(),
      idx: Number(args.allPairsLength),
      token0,
      token1,
      d0: m0.decimals,
      d1: m1.decimals,
      block: Number(BigInt(log.blockNumber)),
    });
  }

  const pairs = loadPairs();
  const addresses = [...pairs.keys(), ...newPairs.map((p) => p.address)];
  const logs = [];
  for (let i = 0; i < addresses.length; i += ADDRESSES_PER_QUERY) {
    const group = addresses.slice(i, i + ADDRESSES_PER_QUERY);
    logs.push(
      ...(await logsInRange(from, to, (a, b) => ({ address: group, topics: [PAIR_TOPICS], fromBlock: hex(a), toBlock: hex(b) })))
    );
  }
  logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  const times = await blockTimes([...logs.map((log) => Number(BigInt(log.blockNumber))), ...newPairs.map((p) => p.block)]);
  const senders = await txSenders(logs.filter((log) => log.topics[0] !== SYNC_TOPIC).map((log) => log.transactionHash));

  transaction(() => {
    for (const pair of newPairs) {
      q(
        `INSERT OR IGNORE INTO pairs (address, idx, token0, token1, created_block, created_time) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(pair.address, pair.idx, pair.token0, pair.token1, pair.block, times.get(pair.block) || 0);
      pairs.set(pair.address, pair);
    }
    for (const log of logs) {
      applyLog(log, pairs.get(log.address.toLowerCase()), times.get(Number(BigInt(log.blockNumber))), senders.get(log.transactionHash));
    }
    setMeta("indexed", to);
  });
}

function bumpHour(pair, time, reserve0, reserve1, volume0 = 0, volume1 = 0, swaps = 0) {
  const hour = Math.floor(time / 3600) * 3600;
  q(
    `INSERT INTO pair_hours (pair, hour, reserve0, reserve1, volume0, volume1, swaps) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pair, hour) DO UPDATE SET
       reserve0 = excluded.reserve0, reserve1 = excluded.reserve1,
       volume0 = pair_hours.volume0 + excluded.volume0, volume1 = pair_hours.volume1 + excluded.volume1,
       swaps = pair_hours.swaps + excluded.swaps`
  ).run(pair, hour, reserve0, reserve1, volume0, volume1, swaps);
}

function applyLog(log, pair, time, sender) {
  if (!pair) return;
  let decoded;
  try {
    decoded = decodeEventLog({ abi: PAIR_EVENTS, data: log.data, topics: log.topics });
  } catch {
    return;
  }
  const { eventName, args } = decoded;
  const block = Number(BigInt(log.blockNumber));
  const logIndex = Number(BigInt(log.logIndex));
  const tx = log.transactionHash;

  if (eventName === "Sync") {
    q("UPDATE pairs SET reserve0 = ?, reserve1 = ? WHERE address = ?").run(args.reserve0.toString(), args.reserve1.toString(), pair.address);
    bumpHour(pair.address, time, toFloat(args.reserve0, pair.d0), toFloat(args.reserve1, pair.d1));
    return;
  }

  const current = q("SELECT reserve0, reserve1 FROM pairs WHERE address = ?").get(pair.address);
  const r0 = toFloat(BigInt(current.reserve0), pair.d0);
  const r1 = toFloat(BigInt(current.reserve1), pair.d1);
  const insert = q(
    `INSERT OR IGNORE INTO events (block, log_index, pair, kind, time, tx, account, amount0_in, amount1_in, amount0_out, amount1_out, volume0, volume1)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  if (eventName === "Swap") {
    const volume0 = toFloat(args.amount0In + args.amount0Out, pair.d0);
    const volume1 = toFloat(args.amount1In + args.amount1Out, pair.d1);
    insert.run(
      block, logIndex, pair.address, "swap", time, tx, sender || args.to.toLowerCase(),
      args.amount0In.toString(), args.amount1In.toString(), args.amount0Out.toString(), args.amount1Out.toString(),
      volume0, volume1
    );
    q("UPDATE pairs SET swaps = swaps + 1 WHERE address = ?").run(pair.address);
    bumpHour(pair.address, time, r0, r1, volume0, volume1, 1);
  } else if (eventName === "Mint") {
    insert.run(block, logIndex, pair.address, "add", time, tx, sender, args.amount0.toString(), args.amount1.toString(), "0", "0", 0, 0);
  } else if (eventName === "Burn") {
    insert.run(block, logIndex, pair.address, "remove", time, tx, sender || args.to.toLowerCase(), "0", "0", args.amount0.toString(), args.amount1.toString(), 0, 0);
  }
}

async function tick(log) {
  const head = Number(BigInt(await rpc("eth_blockNumber")));
  state.chainHead = head;
  const target = head - ENV.confirmations;
  let from = Number(getMeta("indexed", String(ENV.startBlock - 1))) + 1;
  while (from <= target) {
    const to = Math.min(target, from + chunk - 1);
    await indexRange(from, to);
    state.indexed = to;
    from = to + 1;
    if (chunk < ENV.logChunk) chunk = Math.min(ENV.logChunk, chunk * 2);
  }
  state.indexed = Math.max(state.indexed, target);
  if (state.lastError) log.info("indexer recovered");
  state.lastError = "";
}

export function startIndexer(log) {
  const chainId = getMeta("chain_id");
  if (chainId && Number(chainId) !== ENV.chainId) throw new Error(`index.db belongs to chain ${chainId}, not ${ENV.chainId}`);
  const factory = getMeta("factory");
  if (factory && factory !== ENV.factory) throw new Error(`index.db was built for factory ${factory}`);
  setMeta("chain_id", ENV.chainId);
  setMeta("factory", ENV.factory);
  state.indexed = Number(getMeta("indexed", String(ENV.startBlock - 1)));

  const loop = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await tick(log);
    } catch (error) {
      state.lastError = error.message || String(error);
      log.warn({ err: state.lastError }, "indexer error");
    } finally {
      state.running = false;
      setTimeout(loop, ENV.pollMs);
    }
  };
  loop();
}
