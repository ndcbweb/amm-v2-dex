import { formatUnits, zeroAddress } from "viem";
import { FACTORY, PAIR, ROUTER } from "./dex";

/** Direct path plus one hop through each base token (wrapped native, stablecoin, listed tokens). */
export function candidatePaths(from, to, bases) {
  const paths = [[from, to]];
  for (const base of bases) {
    if (base && base !== from && base !== to) paths.push([from, base, to]);
  }
  return paths;
}

/**
 * Quotes every candidate path with the router and returns the best one:
 * most output for an exact input, least input for an exact output.
 */
export async function bestQuote({ publicClient, router, paths, amount, exactIn }) {
  const results = await Promise.all(
    paths.map((path) =>
      publicClient
        .readContract({ address: router, abi: ROUTER, functionName: exactIn ? "getAmountsOut" : "getAmountsIn", args: [amount, path] })
        .then((amounts) => ({ path, amounts }))
        .catch(() => null)
    )
  );
  let best = null;
  for (const result of results) {
    if (!result) continue;
    const out = result.amounts[result.amounts.length - 1];
    const input = result.amounts[0];
    if (exactIn ? out === 0n : input === 0n) continue;
    if (!best || (exactIn ? out > best.amounts[best.amounts.length - 1] : input < best.amounts[0])) best = result;
  }
  return best;
}

/** Spot price along `path` (output per input, decimal-adjusted) from live reserves, for price impact. */
export async function midPrice({ publicClient, factory, path, decimalsOf }) {
  const pairs = await Promise.all(
    path.slice(0, -1).map((token, i) => publicClient.readContract({ address: factory, abi: FACTORY, functionName: "getPair", args: [token, path[i + 1]] }))
  );
  if (pairs.some((pair) => pair === zeroAddress)) return null;
  const data = await Promise.all(
    pairs.map((pair) =>
      Promise.all([
        publicClient.readContract({ address: pair, abi: PAIR, functionName: "getReserves" }),
        publicClient.readContract({ address: pair, abi: PAIR, functionName: "token0" }),
      ])
    )
  );
  let price = 1;
  data.forEach(([[r0, r1], token0], i) => {
    const input = path[i].toLowerCase();
    const output = path[i + 1].toLowerCase();
    const inIs0 = token0.toLowerCase() === input;
    const rIn = Number(formatUnits(inIs0 ? r0 : r1, decimalsOf(input)));
    const rOut = Number(formatUnits(inIs0 ? r1 : r0, decimalsOf(output)));
    price *= rIn > 0 ? rOut / rIn : 0;
  });
  return price;
}
