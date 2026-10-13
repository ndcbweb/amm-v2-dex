"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, parseAbi } from "viem";
import { api } from "./api";

export const NATIVE = "native";

export const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function totalSupply() view returns (uint256)",
]);
export const PAIR = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
export const FACTORY = parseAbi(["function getPair(address, address) view returns (address)"]);
export const WNATIVE = parseAbi(["function deposit() payable", "function withdraw(uint256 wad)"]);
export const ROUTER = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)",
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256, uint256)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)",
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256)",
  "function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256, uint256)",
  "function removeLiquidityETHSupportingFeeOnTransferTokens(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const DexContext = createContext(null);
export const useDex = () => useContext(DexContext);

const lower = (value) => String(value || "").toLowerCase();
const storageKey = (chainId, name) => `dex:${chainId}:${name}`;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function contrastInk(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.6 ? "#111318" : "#ffffff";
}

export function DexProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [indexedTokens, setIndexedTokens] = useState([]);
  const [imported, setImported] = useState([]);
  const [account, setAccount] = useState("");
  const [walletChainId, setWalletChainId] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [prefs, setPrefs] = useState({ slippageBps: null, deadlineMin: 20 });
  const [refreshKey, setRefreshKey] = useState(0);
  const hasWallet = typeof window !== "undefined" && Boolean(window.ethereum);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await api("/config"));
      setConfigError("");
    } catch (error) {
      setConfigError(error.message);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    const timer = setInterval(loadConfig, 30_000);
    return () => clearInterval(timer);
  }, [loadConfig]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/tokens")
        .then((data) => alive && setIndexedTokens(data.tokens || []))
        .catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const chainId = config?.chain.id;

  useEffect(() => {
    if (!chainId) return;
    setImported(readJson(storageKey(chainId, "imported"), []));
    setPrefs((prev) => ({ ...prev, ...readJson(storageKey(chainId, "prefs"), {}) }));
  }, [chainId]);

  useEffect(() => {
    const settings = config?.settings;
    if (!settings) return;
    const root = document.documentElement;
    root.style.setProperty("--brand", settings.brandColor);
    root.style.setProperty("--brand-ink", contrastInk(settings.brandColor));
    document.title = `${settings.name} · Swap`;
    try {
      if (!localStorage.getItem("dex-theme")) root.classList.toggle("dark", settings.defaultTheme !== "light");
    } catch {
      /* private mode */
    }
  }, [config?.settings]);

  const chain = useMemo(() => {
    if (!config) return null;
    return {
      id: config.chain.id,
      name: config.chain.name,
      nativeCurrency: config.chain.native,
      rpcUrls: { default: { http: [config.chain.rpcUrl] } },
      blockExplorers: config.chain.explorerUrl ? { default: { name: "Explorer", url: config.chain.explorerUrl } } : undefined,
    };
  }, [config]);

  const publicClient = useMemo(() => {
    if (!chain || typeof window === "undefined") return null;
    return createPublicClient({ chain, transport: http(`${window.location.origin}/api/rpc`, { batch: { wait: 16, batchSize: 50 } }) });
  }, [chain]);

  /* ---------- wallet ---------- */

  useEffect(() => {
    if (!hasWallet) return undefined;
    const eth = window.ethereum;
    const onAccounts = (accounts) => setAccount(lower(accounts?.[0]));
    const onChain = (id) => setWalletChainId(Number(id));
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    eth.request({ method: "eth_chainId" }).then(onChain).catch(() => {});
    if (readJson("dex:connected", false)) eth.request({ method: "eth_accounts" }).then(onAccounts).catch(() => {});
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [hasWallet]);

  const connect = useCallback(async () => {
    if (!window.ethereum) throw new Error("Install MetaMask or another browser wallet to continue");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    setAccount(lower(accounts?.[0]));
    localStorage.setItem("dex:connected", "true");
    return lower(accounts?.[0]);
  }, []);

  const disconnect = useCallback(() => {
    setAccount("");
    localStorage.removeItem("dex:connected");
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!window.ethereum || !config) return;
    const hexId = `0x${config.chain.id.toString(16)}`;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (error) {
      if (error?.code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(error?.message || "")) throw error;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: config.chain.name,
            nativeCurrency: config.chain.native,
            rpcUrls: [config.chain.rpcUrl],
            ...(config.chain.explorerUrl ? { blockExplorerUrls: [config.chain.explorerUrl] } : {}),
          },
        ],
      });
    }
    setWalletChainId(config.chain.id);
  }, [config]);

  const wrongNetwork = Boolean(account && walletChainId && chainId && walletChainId !== chainId);

  /* ---------- transactions ---------- */

  const pushToast = useCallback((toast) => {
    setToasts((rows) => [...rows.filter((row) => row.id !== toast.id), toast].slice(-4));
    if (toast.status !== "pending") setTimeout(() => setToasts((rows) => rows.filter((row) => row.id !== toast.id)), 9000);
  }, []);

  /** Runs a wallet write: connects, switches network, sends, waits for the receipt and reports progress. */
  const send = useCallback(
    async (label, write) => {
      const from = account || (await connect());
      if (Number(await window.ethereum.request({ method: "eth_chainId" })) !== chainId) await switchNetwork();
      const client = createWalletClient({ account: from, chain, transport: custom(window.ethereum) });
      // Pools write their price accumulators only when time has passed since the last trade, so an estimate taken
      // in the same second as that trade comes in low. A 25% margin keeps such transactions from running out of gas.
      const walletClient = {
        writeContract: async (request) => {
          if (request.gas) return client.writeContract(request);
          const gas = await publicClient.estimateContractGas(request);
          return client.writeContract({ ...request, gas: (gas * 125n) / 100n });
        },
      };
      const id = `${Date.now()}-${Math.random()}`;
      pushToast({ id, label, status: "wallet" });
      let hash;
      try {
        hash = await write(walletClient, from);
      } catch (error) {
        setToasts((rows) => rows.filter((row) => row.id !== id));
        throw new Error(error?.shortMessage || error?.details || error?.message || "Transaction cancelled");
      }
      pushToast({ id, label, status: "pending", hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1500, timeout: 300_000 });
      pushToast({ id, label, status: receipt.status === "success" ? "success" : "failed", hash });
      setRefreshKey((key) => key + 1);
      if (receipt.status !== "success") throw new Error(`${label} failed on-chain`);
      return receipt;
    },
    [account, chain, chainId, connect, publicClient, pushToast, switchNetwork]
  );

  /* ---------- tokens ---------- */

  const tokens = useMemo(() => {
    if (!config) return [];
    const map = new Map();
    map.set(NATIVE, { address: NATIVE, native: true, ...config.chain.native, logoURI: "" });
    const add = (token, source) => {
      const address = lower(token.address);
      if (!/^0x[0-9a-f]{40}$/.test(address)) return;
      const prev = map.get(address);
      map.set(address, { ...prev, ...token, address, logoURI: token.logoURI || prev?.logoURI || "", source: prev?.source || source });
    };
    indexedTokens.forEach((token) => add(token, "pool"));
    imported.forEach((token) => add(token, "imported"));
    config.settings.tokens.forEach((token) => add(token, "list"));
    return [...map.values()];
  }, [config, indexedTokens, imported]);

  const importToken = useCallback(
    (token) => {
      const next = [...imported.filter((row) => lower(row.address) !== lower(token.address)), token].slice(-100);
      setImported(next);
      localStorage.setItem(storageKey(chainId, "imported"), JSON.stringify(next));
    },
    [chainId, imported]
  );

  const savePrefs = useCallback(
    (patch) => {
      setPrefs((prev) => {
        const next = { ...prev, ...patch };
        localStorage.setItem(storageKey(chainId, "prefs"), JSON.stringify(next));
        return next;
      });
    },
    [chainId]
  );

  const slippageBps = prefs.slippageBps ?? config?.settings.defaultSlippageBps ?? 50;
  const tokenByAddress = useCallback((address) => tokens.find((token) => token.address === lower(address)) || null, [tokens]);
  const routeAddress = useCallback((token) => (token?.native ? config?.contracts.wnative : token?.address), [config]);
  const explorerTx = (hash) => (config?.chain.explorerUrl ? `${config.chain.explorerUrl}/tx/${hash}` : "");
  const explorerAddress = (address) => (config?.chain.explorerUrl ? `${config.chain.explorerUrl}/address/${address}` : "");

  const value = {
    config,
    configError,
    chain,
    publicClient,
    hasWallet,
    account,
    walletChainId,
    wrongNetwork,
    connect,
    disconnect,
    switchNetwork,
    send,
    toasts,
    tokens,
    tokenByAddress,
    routeAddress,
    importToken,
    slippageBps,
    deadlineMin: prefs.deadlineMin,
    savePrefs,
    refreshKey,
    refresh: () => setRefreshKey((key) => key + 1),
    explorerTx,
    explorerAddress,
  };
  return <DexContext.Provider value={value}>{children}</DexContext.Provider>;
}

/** Balances of `tokens` for the connected account; native coin via eth_getBalance. */
export function useBalances(list) {
  const { publicClient, account, refreshKey } = useDex();
  const [balances, setBalances] = useState({});
  const key = list.map((token) => token?.address).filter(Boolean).join(",");
  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => {
    if (!publicClient || !account) {
      setBalances({});
      return undefined;
    }
    let alive = true;
    const load = async () => {
      const targets = listRef.current.filter(Boolean);
      const results = await Promise.all(
        targets.map((token) =>
          (token.native
            ? publicClient.getBalance({ address: account })
            : publicClient.readContract({ address: token.address, abi: ERC20, functionName: "balanceOf", args: [account] })
          ).catch(() => null)
        )
      );
      if (!alive) return;
      const next = {};
      targets.forEach((token, i) => {
        if (results[i] != null) next[token.address] = results[i];
      });
      setBalances(next);
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [publicClient, account, key, refreshKey]);

  return balances;
}

export function deadline(minutes) {
  return BigInt(Math.floor(Date.now() / 1000) + Math.max(1, Number(minutes) || 20) * 60);
}

export function withSlippageDown(amount, bps) {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

export function withSlippageUp(amount, bps) {
  return (amount * BigInt(10_000 + bps)) / 10_000n;
}
