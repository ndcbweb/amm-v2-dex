"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useDisplayToken } from "@/components/tables";
import { PairLogo, Spinner } from "@/components/ui";
import { useApi } from "@/lib/api";
import { NATIVE, PAIR, useDex } from "@/lib/dex";
import { money, num, pct } from "@/lib/format";

export default function PoolPage() {
  const { config } = useDex();
  if (!config) return <p className="py-20 text-center text-muted">Loading…</p>;
  return <Pool />;
}

function Pool() {
  const { account, publicClient, connect, refreshKey, config } = useDex();
  const show = useDisplayToken();
  const routeId = (token) => (token.native ? NATIVE : token.address);
  const { data } = useApi("/pairs?sort=tvl", { refreshMs: 30_000 });
  const [positions, setPositions] = useState({ status: "idle", rows: [] });

  useEffect(() => {
    if (!account || !publicClient || !data?.pairs) return undefined;
    let alive = true;
    setPositions((prev) => ({ ...prev, status: prev.rows.length ? "ready" : "loading" }));
    (async () => {
      const balances = await Promise.all(
        data.pairs.map((pair) => publicClient.readContract({ address: pair.address, abi: PAIR, functionName: "balanceOf", args: [account] }).catch(() => 0n))
      );
      const held = data.pairs.map((pair, i) => ({ pair, balance: balances[i] })).filter((row) => row.balance > 0n);
      const supplies = await Promise.all(held.map((row) => publicClient.readContract({ address: row.pair.address, abi: PAIR, functionName: "totalSupply" })));
      if (!alive) return;
      setPositions({
        status: "ready",
        rows: held.map((row, i) => {
          const share = Number(row.balance) / Number(supplies[i]);
          return {
            ...row,
            share,
            amount0: (BigInt(row.pair.reserve0) * row.balance) / supplies[i],
            amount1: (BigInt(row.pair.reserve1) * row.balance) / supplies[i],
            value: row.pair.tvl != null ? row.pair.tvl * share : null,
          };
        }),
      });
    })().catch(() => alive && setPositions({ status: "ready", rows: [] }));
    return () => {
      alive = false;
    };
  }, [account, publicClient, data, refreshKey]);

  const symbol = config?.chain.native.symbol;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Liquidity</h1>
          <p className="mt-1 text-sm text-muted">
            Add tokens to a pool to earn {config ? `${config.protocol?.swapFeeBps / 100}%` : "a share"} of every trade, in proportion to your share of the pool.
          </p>
        </div>
        <Link href="/add/" className="btn-primary">
          + Add liquidity
        </Link>
      </div>

      <section className="card p-5">
        <h2 className="mb-4 font-semibold">Your positions</h2>
        {!account ? (
          <div className="py-8 text-center">
            <p className="text-sm text-muted">Connect a wallet to see your liquidity.</p>
            <button type="button" className="btn-primary mt-4" onClick={() => connect().catch(() => {})}>
              Connect wallet
            </button>
          </div>
        ) : positions.status === "loading" ? (
          <div className="flex justify-center py-8 text-muted">
            <Spinner />
          </div>
        ) : !positions.rows.length ? (
          <p className="py-8 text-center text-sm text-muted">You have no liquidity positions yet.</p>
        ) : (
          <div className="space-y-3">
            {positions.rows.map(({ pair, balance, share, amount0, amount1, value }) => {
              const t0 = show(pair.token0);
              const t1 = show(pair.token1);
              return (
                <div key={pair.address} className="well p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Link href={`/pair/?id=${pair.address}`} className="flex items-center gap-3">
                      <PairLogo a={t0} b={t1} />
                      <span className="font-semibold">
                        {t0.symbol}/{t1.symbol}
                      </span>
                    </Link>
                    <div className="flex gap-2">
                      <Link href={`/add/?a=${routeId(t0)}&b=${routeId(t1)}`} className="btn-soft !py-2">
                        Add
                      </Link>
                      <Link href={`/remove/?pair=${pair.address}`} className="btn-ghost !rounded-2xl !py-2">
                        Remove
                      </Link>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <Info label={`Pooled ${t0.symbol}`} value={num(formatUnits(amount0, pair.token0.decimals))} />
                    <Info label={`Pooled ${t1.symbol}`} value={num(formatUnits(amount1, pair.token1.decimals))} />
                    <Info label="Pool share" value={share < 0.0001 ? "<0.01%" : pct(share).replace("+", "")} />
                    <Info label="Value" value={money(value, data?.nativeUsd, symbol)} />
                  </div>
                  <p className="mt-3 text-xs text-muted">LP tokens: {num(formatUnits(balance, 18))}</p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between p-5">
          <h2 className="font-semibold">Top pools</h2>
          <Link href="/explore/?tab=pools" className="link text-sm">
            View all
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Pool</th>
                <th className="text-right">TVL</th>
                <th className="text-right">Volume 24h</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.pairs || []).slice(0, 8).map((pair) => {
                const t0 = show(pair.token0);
                const t1 = show(pair.token1);
                return (
                  <tr key={pair.address}>
                    <td>
                      <Link href={`/pair/?id=${pair.address}`} className="flex items-center gap-3 font-medium">
                        <PairLogo a={t0} b={t1} size={22} />
                        {t0.symbol}/{t1.symbol}
                      </Link>
                    </td>
                    <td className="text-right tabular-nums">{money(pair.tvl, data.nativeUsd, symbol)}</td>
                    <td className="text-right tabular-nums">{money(pair.volume24h, data.nativeUsd, symbol)}</td>
                    <td className="text-right">
                      <Link href={`/add/?a=${routeId(t0)}&b=${routeId(t1)}`} className="link text-sm">
                        Add
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {data && !data.pairs.length ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-muted">
                    No pools yet. Be the first to add liquidity.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p className="mt-1 font-medium tabular-nums">{value}</p>
    </div>
  );
}
