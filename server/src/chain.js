import { decodeFunctionResult, encodeFunctionData, hexToString, parseAbi } from "viem";
import { ENV } from "./config.js";
import { q } from "./db.js";
import { rpc, rpcBatch } from "./rpc.js";

export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const BYTES32_ABI = parseAbi(["function name() view returns (bytes32)", "function symbol() view returns (bytes32)"]);
export const FACTORY_ABI = parseAbi([
  "function swapFeeBps() view returns (uint256)",
  "function protocolFeeShareBps() view returns (uint256)",
  "function feeTo() view returns (address)",
  "function feeToSetter() view returns (address)",
  "function allPairsLength() view returns (uint256)",
  "function lpName() view returns (string)",
  "function lpSymbol() view returns (string)",
]);

const call = (to, abi, functionName) => ["eth_call", [{ to, data: encodeFunctionData({ abi, functionName }) }, "latest"]];

function decodeText(abi, name, data) {
  try {
    return decodeFunctionResult({ abi, functionName: name, data });
  } catch {
    try {
      return hexToString(decodeFunctionResult({ abi: BYTES32_ABI, functionName: name, data }), { size: 32 }).replace(/\0+$/, "");
    } catch {
      return "";
    }
  }
}

/** Reads (and caches) ERC-20 metadata; tokens that answer nothing get placeholders rather than failing the index. */
export async function tokenMeta(address) {
  const hit = q("SELECT address, symbol, name, decimals FROM tokens WHERE address = ?").get(address);
  if (hit) return hit;
  let results;
  try {
    results = await rpcBatch([call(address, ERC20_ABI, "name"), call(address, ERC20_ABI, "symbol"), call(address, ERC20_ABI, "decimals")]);
  } catch {
    results = await Promise.all(
      ["name", "symbol", "decimals"].map((fn) => rpc(...call(address, ERC20_ABI, fn)).catch(() => "0x"))
    );
  }
  const [nameData, symbolData, decimalsData] = results;
  let decimals = 18;
  try {
    decimals = Number(decodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", data: decimalsData }));
  } catch {
    /* non-standard token */
  }
  const isNative = address === ENV.wnative;
  const symbol = (decodeText(ERC20_ABI, "symbol", symbolData) || (isNative ? `W${ENV.nativeSymbol}` : "TOKEN")).slice(0, 24);
  const name = (decodeText(ERC20_ABI, "name", nameData) || symbol).slice(0, 80);
  const row = { address, symbol, name, decimals: Number.isInteger(decimals) && decimals <= 36 ? decimals : 18 };
  q("INSERT OR REPLACE INTO tokens (address, symbol, name, decimals) VALUES (?, ?, ?, ?)").run(row.address, row.symbol, row.name, row.decimals);
  return row;
}

export async function factoryState() {
  const names = ["swapFeeBps", "protocolFeeShareBps", "feeTo", "feeToSetter", "allPairsLength", "lpName", "lpSymbol"];
  const results = await rpcBatch(names.map((fn) => call(ENV.factory, FACTORY_ABI, fn)));
  const out = {};
  names.forEach((fn, i) => {
    out[fn] = decodeFunctionResult({ abi: FACTORY_ABI, functionName: fn, data: results[i] });
  });
  return {
    swapFeeBps: Number(out.swapFeeBps),
    protocolFeeShareBps: Number(out.protocolFeeShareBps),
    feeTo: out.feeTo.toLowerCase(),
    owner: out.feeToSetter.toLowerCase(),
    pairCount: Number(out.allPairsLength),
    lpName: out.lpName,
    lpSymbol: out.lpSymbol,
  };
}
