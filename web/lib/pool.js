"use client";

import { useEffect, useState } from "react";
import { zeroAddress } from "viem";
import { FACTORY, PAIR, useDex } from "./dex";

/** Live pool state for tokenA/tokenB with reserves ordered as (A, B). */
export function usePool(tokenA, tokenB) {
  const { publicClient, config, account, routeAddress, refreshKey } = useDex();
  const [pool, setPool] = useState({ status: "idle" });
  const a = tokenA ? routeAddress(tokenA) : null;
  const b = tokenB ? routeAddress(tokenB) : null;

  useEffect(() => {
    if (!publicClient || !a || !b || a === b) {
      setPool({ status: "idle" });
      return undefined;
    }
    let alive = true;
    (async () => {
      const pair = await publicClient.readContract({ address: config.contracts.factory, abi: FACTORY, functionName: "getPair", args: [a, b] });
      if (pair === zeroAddress) {
        if (alive) setPool({ status: "missing", pair: null, reserveA: 0n, reserveB: 0n, totalSupply: 0n, balance: 0n });
        return;
      }
      const [[r0, r1], token0, totalSupply, balance] = await Promise.all([
        publicClient.readContract({ address: pair, abi: PAIR, functionName: "getReserves" }),
        publicClient.readContract({ address: pair, abi: PAIR, functionName: "token0" }),
        publicClient.readContract({ address: pair, abi: PAIR, functionName: "totalSupply" }),
        account ? publicClient.readContract({ address: pair, abi: PAIR, functionName: "balanceOf", args: [account] }) : 0n,
      ]);
      const aIs0 = token0.toLowerCase() === a;
      if (alive) {
        setPool({
          status: r0 > 0n ? "ready" : "empty",
          pair: pair.toLowerCase(),
          reserveA: aIs0 ? r0 : r1,
          reserveB: aIs0 ? r1 : r0,
          totalSupply,
          balance,
        });
      }
    })().catch((error) => alive && setPool({ status: "error", error: error.message }));
    return () => {
      alive = false;
    };
  }, [publicClient, config, a, b, account, refreshKey]);

  return pool;
}
