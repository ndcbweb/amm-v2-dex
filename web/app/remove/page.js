"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatUnits, maxUint256 } from "viem";
import { PairLogo, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { ERC20, NATIVE, PAIR, ROUTER, deadline, useDex, withSlippageDown } from "@/lib/dex";
import { num } from "@/lib/format";

function RemoveLiquidity() {
  const dex = useDex();
  const { config, publicClient, account, send, slippageBps, deadlineMin, refreshKey, tokenByAddress } = dex;
  const pair = String(useSearchParams().get("pair") || "").toLowerCase();
  const [info, setInfo] = useState({ status: "loading" });
  const [percent, setPercent] = useState(50);
  const [receiveNative, setReceiveNative] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!publicClient || !/^0x[0-9a-f]{40}$/.test(pair)) {
      setInfo({ status: "error", error: "Pick a pool from your positions" });
      return undefined;
    }
    let alive = true;
    (async () => {
      const read = (functionName, args) => publicClient.readContract({ address: pair, abi: [...PAIR, ...ERC20], functionName, args });
      const [token0, token1] = (await Promise.all([read("token0"), read("token1")])).map((address) => address.toLowerCase());
      const meta = async (address) => tokenByAddress(address) || (await api(`/token/${address}`)).token;
      const [t0, t1] = await Promise.all([meta(token0), meta(token1)]);
      const [[r0, r1], totalSupply, balance, allowance] = await Promise.all([
        read("getReserves"),
        read("totalSupply"),
        account ? read("balanceOf", [account]) : 0n,
        account ? read("allowance", [account, config.contracts.router]) : 0n,
      ]);
      if (alive) setInfo({ status: "ready", t0, t1, r0, r1, totalSupply, balance, allowance });
    })().catch((err) => alive && setInfo({ status: "error", error: err.message }));
    return () => {
      alive = false;
    };
  }, [pair, publicClient, account, config, refreshKey, tokenByAddress]);

  const wnative = config.contracts.wnative;
  const nativeSide = info.status === "ready" ? (info.t0.address === wnative ? 0 : info.t1.address === wnative ? 1 : -1) : -1;
  const liquidity = info.status === "ready" ? (info.balance * BigInt(percent)) / 100n : 0n;
  const out0 = info.status === "ready" && info.totalSupply > 0n ? (info.r0 * liquidity) / info.totalSupply : 0n;
  const out1 = info.status === "ready" && info.totalSupply > 0n ? (info.r1 * liquidity) / info.totalSupply : 0n;
  const native = tokenByAddress(NATIVE);
  const labelFor = (side) => {
    const token = side === 0 ? info.t0 : info.t1;
    return nativeSide === side && receiveNative ? native.symbol : token.symbol;
  };
  const display = useMemo(() => {
    if (info.status !== "ready") return [];
    return [info.t0, info.t1].map((token, side) => (nativeSide === side && receiveNative ? native : token));
  }, [info, nativeSide, receiveNative, native]);

  async function approve() {
    setBusy("approve");
    setError("");
    try {
      await send("Approve LP tokens", (wallet, from) =>
        wallet.writeContract({ address: pair, abi: ERC20, functionName: "approve", args: [config.contracts.router, maxUint256], account: from })
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    setBusy("remove");
    setError("");
    try {
      await send(`Remove ${labelFor(0)}/${labelFor(1)} liquidity`, async (wallet, from) => {
        const dl = deadline(deadlineMin);
        const min0 = withSlippageDown(out0, slippageBps);
        const min1 = withSlippageDown(out1, slippageBps);
        const router = config.contracts.router;
        if (nativeSide >= 0 && receiveNative) {
          const token = nativeSide === 0 ? info.t1.address : info.t0.address;
          const [minToken, minNative] = nativeSide === 0 ? [min1, min0] : [min0, min1];
          let call = { functionName: "removeLiquidityETH", args: [token, liquidity, minToken, minNative, from, dl] };
          try {
            await publicClient.estimateContractGas({ address: router, abi: ROUTER, account: from, ...call });
          } catch {
            call = { ...call, functionName: "removeLiquidityETHSupportingFeeOnTransferTokens" };
          }
          return wallet.writeContract({ address: router, abi: ROUTER, account: from, ...call });
        }
        return wallet.writeContract({
          address: router,
          abi: ROUTER,
          functionName: "removeLiquidity",
          args: [info.t0.address, info.t1.address, liquidity, min0, min1, from, dl],
          account: from,
        });
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  if (info.status === "loading") {
    return (
      <div className="flex justify-center py-20 text-muted">
        <Spinner size={22} />
      </div>
    );
  }
  if (info.status === "error") return <p className="py-20 text-center text-sm text-down">{info.error}</p>;

  let action = { label: "Remove", onClick: remove };
  if (!account) action = { label: "Connect wallet", onClick: () => dex.connect().catch((err) => setError(err.message)) };
  else if (info.balance === 0n) action = { label: "You have no liquidity in this pool", disabled: true };
  else if (liquidity === 0n) action = { label: "Choose an amount", disabled: true };
  else if (info.allowance < liquidity) action = { label: "Approve LP tokens", onClick: approve };

  return (
    <div className="mx-auto w-full max-w-[480px]">
      <div className="card p-5">
        <div className="mb-4 flex items-center gap-2">
          <Link href="/pool/" className="btn-ghost h-9 w-9 !rounded-xl !p-0" aria-label="Back">
            ←
          </Link>
          <h1 className="text-lg font-semibold">Remove liquidity</h1>
        </div>
        <div className="mb-5 flex items-center gap-3">
          <PairLogo a={display[0]} b={display[1]} />
          <span className="font-semibold">
            {labelFor(0)}/{labelFor(1)}
          </span>
        </div>

        <div className="well p-4">
          <p className="label">Amount</p>
          <p className="mt-1 text-4xl font-semibold tabular-nums">{percent}%</p>
          <input type="range" min="0" max="100" value={percent} onChange={(event) => setPercent(Number(event.target.value))} className="mt-3 w-full accent-[var(--brand)]" />
          <div className="mt-3 grid grid-cols-4 gap-2">
            {[25, 50, 75, 100].map((value) => (
              <button key={value} type="button" className={`btn !rounded-xl !py-1.5 ${percent === value ? "bg-brand text-brand-ink" : "bg-black/5 dark:bg-white/5"}`} onClick={() => setPercent(value)}>
                {value === 100 ? "Max" : `${value}%`}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 space-y-2 rounded-2xl border border-black/5 p-4 text-sm dark:border-white/5">
          <p className="label">You will receive at least</p>
          {[out0, out1].map((amount, side) => (
            <div key={side} className="flex justify-between">
              <span className="tabular-nums">{num(formatUnits(withSlippageDown(amount, slippageBps), (side === 0 ? info.t0 : info.t1).decimals))}</span>
              <span className="font-medium">{labelFor(side)}</span>
            </div>
          ))}
          {nativeSide >= 0 ? (
            <button type="button" className="link pt-1 text-xs" onClick={() => setReceiveNative((v) => !v)}>
              Receive {receiveNative ? (nativeSide === 0 ? info.t0.symbol : info.t1.symbol) : native.symbol} instead
            </button>
          ) : null}
        </div>

        <button type="button" className="btn-primary mt-4 h-14 w-full text-base" disabled={action.disabled || Boolean(busy)} onClick={action.onClick}>
          {busy ? <Spinner /> : null}
          {busy === "approve" ? "Approving…" : busy === "remove" ? "Removing…" : action.label}
        </button>
        {error ? <p className="mt-3 break-words text-sm text-down">{error}</p> : null}
        <p className="mt-4 text-xs text-muted">Your LP balance: {num(formatUnits(info.balance, 18))}</p>
      </div>
    </div>
  );
}

export default function RemovePage() {
  const { config } = useDex();
  if (!config) return <p className="py-20 text-center text-muted">Loading…</p>;
  return (
    <Suspense fallback={null}>
      <RemoveLiquidity />
    </Suspense>
  );
}
