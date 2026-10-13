"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatUnits, maxUint256, parseUnits } from "viem";
import { AmountField, SlippageSettings, Spinner, TokenSelect } from "@/components/ui";
import { ERC20, NATIVE, ROUTER, deadline, useBalances, useDex, withSlippageDown } from "@/lib/dex";
import { clampDecimals, num, pct } from "@/lib/format";
import { usePool } from "@/lib/pool";

function parse(text, decimals) {
  try {
    return parseUnits(text || "0", decimals);
  } catch {
    return 0n;
  }
}

function AddLiquidity() {
  const dex = useDex();
  const { config, tokens, tokenByAddress, publicClient, account, send, slippageBps, deadlineMin, refreshKey } = dex;
  const params = useSearchParams();
  const [tokenA, setTokenA] = useState(null);
  const [tokenB, setTokenB] = useState(null);
  const [field, setField] = useState("a");
  const [typed, setTyped] = useState({ a: "", b: "" });
  const [picker, setPicker] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [allowances, setAllowances] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!tokens.length || tokenA) return;
    setTokenA(tokenByAddress(params.get("a") || NATIVE) || tokenByAddress(NATIVE));
    const b = params.get("b") && tokenByAddress(params.get("b"));
    setTokenB(b || null);
  }, [tokens, tokenA, params, tokenByAddress]);

  const pool = usePool(tokenA, tokenB);
  const balances = useBalances([tokenA, tokenB]);
  const hasPrice = pool.status === "ready";

  const amountA = field === "a" ? parse(typed.a, tokenA?.decimals ?? 18) : hasPrice ? (parse(typed.b, tokenB?.decimals ?? 18) * pool.reserveA) / pool.reserveB : parse(typed.a, tokenA?.decimals ?? 18);
  const amountB = field === "b" ? parse(typed.b, tokenB?.decimals ?? 18) : hasPrice ? (parse(typed.a, tokenA?.decimals ?? 18) * pool.reserveB) / pool.reserveA : parse(typed.b, tokenB?.decimals ?? 18);

  const shown = (side) => {
    if (!hasPrice || field === side) return typed[side];
    const raw = side === "a" ? amountA : amountB;
    const token = side === "a" ? tokenA : tokenB;
    return raw > 0n ? clampDecimals(formatUnits(raw, token.decimals), 8) : "";
  };

  useEffect(() => {
    if (!account || !publicClient) return;
    let alive = true;
    Promise.all(
      [tokenA, tokenB].map((token) =>
        token && !token.native
          ? publicClient.readContract({ address: token.address, abi: ERC20, functionName: "allowance", args: [account, config.contracts.router] }).catch(() => null)
          : null
      )
    ).then(([a, b]) => alive && setAllowances({ a, b }));
    return () => {
      alive = false;
    };
  }, [tokenA, tokenB, account, publicClient, config, refreshKey]);

  const pick = (token) => {
    if (picker === "a") {
      if (tokenB?.address === token.address) setTokenB(tokenA);
      setTokenA(token);
    } else {
      if (tokenA?.address === token.address) setTokenA(tokenB);
      setTokenB(token);
    }
    setPicker(null);
  };

  const sameUnderlying = tokenA && tokenB && dex.routeAddress(tokenA) === dex.routeAddress(tokenB);
  const priceAB = hasPrice
    ? Number(formatUnits(pool.reserveB, tokenB.decimals)) / Number(formatUnits(pool.reserveA, tokenA.decimals))
    : amountA > 0n && amountB > 0n
      ? Number(formatUnits(amountB, tokenB.decimals)) / Number(formatUnits(amountA, tokenA.decimals))
      : null;
  const share = hasPrice && amountA > 0n ? Number(amountA) / Number(pool.reserveA + amountA) : amountA > 0n && amountB > 0n ? 1 : null;
  const needA = tokenA && !tokenA.native && allowances.a != null && amountA > 0n && allowances.a < amountA;
  const needB = tokenB && !tokenB.native && allowances.b != null && amountB > 0n && allowances.b < amountB;
  const short = (side) => {
    const token = side === "a" ? tokenA : tokenB;
    const amount = side === "a" ? amountA : amountB;
    const balance = token ? balances[token.address] : null;
    return balance != null && amount > balance ? token : null;
  };

  async function approve(token) {
    setBusy(`approve-${token.address}`);
    setError("");
    try {
      await send(`Approve ${token.symbol}`, (wallet, from) =>
        wallet.writeContract({ address: token.address, abi: ERC20, functionName: "approve", args: [config.contracts.router, maxUint256], account: from })
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function supply() {
    setBusy("supply");
    setError("");
    try {
      await send(`Add ${tokenA.symbol}/${tokenB.symbol} liquidity`, (wallet, from) => {
        const dl = deadline(deadlineMin);
        const minA = hasPrice ? withSlippageDown(amountA, slippageBps) : amountA;
        const minB = hasPrice ? withSlippageDown(amountB, slippageBps) : amountB;
        const router = config.contracts.router;
        if (tokenA.native || tokenB.native) {
          const [token, amountToken, amountNative, minToken, minNative] = tokenA.native ? [tokenB, amountB, amountA, minB, minA] : [tokenA, amountA, amountB, minA, minB];
          return wallet.writeContract({
            address: router,
            abi: ROUTER,
            functionName: "addLiquidityETH",
            args: [token.address, amountToken, minToken, minNative, from, dl],
            value: amountNative,
            account: from,
          });
        }
        return wallet.writeContract({
          address: router,
          abi: ROUTER,
          functionName: "addLiquidity",
          args: [tokenA.address, tokenB.address, amountA, amountB, minA, minB, from, dl],
          account: from,
        });
      });
      setTyped({ a: "", b: "" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  let action = { label: "Add liquidity", onClick: supply };
  if (!account) action = { label: "Connect wallet", onClick: () => dex.connect().catch((err) => setError(err.message)) };
  else if (!tokenA || !tokenB) action = { label: "Select a token", disabled: true };
  else if (sameUnderlying) action = { label: "Pick two different tokens", disabled: true };
  else if (!(amountA > 0n && amountB > 0n)) action = { label: "Enter amounts", disabled: true };
  else if (short("a") || short("b")) action = { label: `Insufficient ${(short("a") || short("b")).symbol} balance`, disabled: true };
  else if (needA) action = { label: `Approve ${tokenA.symbol}`, onClick: () => approve(tokenA) };
  else if (needB) action = { label: `Approve ${tokenB.symbol}`, onClick: () => approve(tokenB) };
  else if (!hasPrice) action = { label: "Create pool & add liquidity", onClick: supply };

  return (
    <div className="mx-auto w-full max-w-[480px]">
      <div className="card p-3">
        <div className="flex items-center justify-between px-2 pb-3 pt-1">
          <div className="flex items-center gap-2">
            <Link href="/pool/" className="btn-ghost h-9 w-9 !rounded-xl !p-0" aria-label="Back">
              ←
            </Link>
            <h1 className="text-lg font-semibold">Add liquidity</h1>
          </div>
          <button type="button" className="btn-ghost h-9 !rounded-xl text-xs text-muted" onClick={() => setSettingsOpen(true)}>
            {slippageBps / 100}% slippage
          </button>
        </div>

        {tokenA && tokenB && !sameUnderlying && (pool.status === "missing" || pool.status === "empty") ? (
          <div className="mb-3 rounded-2xl bg-brand/10 px-4 py-3 text-sm">
            <p className="font-semibold text-brand">You are the first liquidity provider</p>
            <p className="mt-1 text-xs text-muted">The ratio of tokens you add sets the starting price of this pool. Check it against other markets so you are not arbitraged.</p>
          </div>
        ) : null}

        <AmountField
          label="Token A"
          token={tokenA}
          value={shown("a")}
          onChange={(value) => {
            setField("a");
            setTyped((prev) => ({ ...prev, a: clampDecimals(value, tokenA?.decimals ?? 18) }));
          }}
          onToken={() => setPicker("a")}
          balance={tokenA ? balances[tokenA.address] : null}
          onMax={() => {
            const balance = balances[tokenA.address];
            const reserve = tokenA.native ? parseUnits("0.005", 18) : 0n;
            setField("a");
            setTyped((prev) => ({ ...prev, a: formatUnits(balance > reserve ? balance - reserve : 0n, tokenA.decimals) }));
          }}
        />
        <div className="relative z-10 -my-3 flex justify-center">
          <span className="grid h-10 w-10 place-items-center rounded-xl border-4 border-white bg-black/5 text-lg dark:border-panel dark:bg-field">+</span>
        </div>
        <AmountField
          label="Token B"
          token={tokenB}
          value={shown("b")}
          onChange={(value) => {
            setField("b");
            setTyped((prev) => ({ ...prev, b: clampDecimals(value, tokenB?.decimals ?? 18) }));
          }}
          onToken={() => setPicker("b")}
          balance={tokenB ? balances[tokenB.address] : null}
          onMax={
            tokenB
              ? () => {
                  const balance = balances[tokenB.address];
                  const reserve = tokenB.native ? parseUnits("0.005", 18) : 0n;
                  setField("b");
                  setTyped((prev) => ({ ...prev, b: formatUnits(balance > reserve ? balance - reserve : 0n, tokenB.decimals) }));
                }
              : undefined
          }
        />

        {tokenA && tokenB && priceAB ? (
          <div className="mt-3 grid grid-cols-3 gap-2 rounded-2xl border border-black/5 p-4 text-center text-sm dark:border-white/5">
            <div>
              <p className="font-semibold tabular-nums">{num(priceAB)}</p>
              <p className="text-xs text-muted">
                {tokenB.symbol} per {tokenA.symbol}
              </p>
            </div>
            <div>
              <p className="font-semibold tabular-nums">{num(1 / priceAB)}</p>
              <p className="text-xs text-muted">
                {tokenA.symbol} per {tokenB.symbol}
              </p>
            </div>
            <div>
              <p className="font-semibold tabular-nums">{share == null ? "–" : share < 0.0001 ? "<0.01%" : pct(share).replace("+", "")}</p>
              <p className="text-xs text-muted">Share of pool</p>
            </div>
          </div>
        ) : null}

        <button type="button" className="btn-primary mt-3 h-14 w-full text-base" disabled={action.disabled || Boolean(busy)} onClick={action.onClick}>
          {busy ? <Spinner /> : null}
          {busy.startsWith("approve") ? "Approving…" : busy === "supply" ? "Adding liquidity…" : action.label}
        </button>
        {error ? <p className="mt-3 break-words px-2 text-sm text-down">{error}</p> : null}
      </div>

      {pool.status === "ready" && pool.balance > 0n ? (
        <div className="card mt-4 p-5 text-sm">
          <p className="font-semibold">Your position</p>
          <p className="mt-2 text-muted">
            {num(formatUnits((pool.reserveA * pool.balance) / pool.totalSupply, tokenA.decimals))} {tokenA.symbol} +{" "}
            {num(formatUnits((pool.reserveB * pool.balance) / pool.totalSupply, tokenB.decimals))} {tokenB.symbol}
          </p>
          <Link href={`/remove/?pair=${pool.pair}`} className="link mt-2 inline-block">
            Remove liquidity
          </Link>
        </div>
      ) : null}

      {picker ? <TokenSelect onSelect={pick} onClose={() => setPicker(null)} exclude={picker === "a" ? tokenA?.address : tokenB?.address} /> : null}
      {settingsOpen ? <SlippageSettings onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}

export default function AddPage() {
  const { config } = useDex();
  if (!config) return <p className="py-20 text-center text-muted">Loading…</p>;
  return (
    <Suspense fallback={null}>
      <AddLiquidity />
    </Suspense>
  );
}
