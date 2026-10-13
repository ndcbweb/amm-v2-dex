#!/usr/bin/env node
// Deploys the DEX on a dev chain (anvil) from the exported artifacts, the same way the Console wizard does,
// then creates pools and trades. Prints the deployment as JSON.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, maxUint256, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const KEY = process.env.DEPLOYER_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const artifacts = JSON.parse(readFileSync(new URL("../../artifacts/nadcab-v2.json", import.meta.url)));
const testToken = JSON.parse(readFileSync(new URL("../../contracts/out/NadcabV2.t.sol/TestToken.json", import.meta.url)));

const account = privateKeyToAccount(KEY);
const chainId = Number(process.env.CHAIN_ID || 31337);
const chain = { id: chainId, name: "dev", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

async function deploy(abi, bytecode, args) {
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress, block: Number(receipt.blockNumber) };
}

async function send(address, abi, functionName, args, value) {
  const gas = await pub.estimateContractGas({ address, abi, functionName, args, value, account });
  const hash = await wallet.writeContract({ address, abi, functionName, args, value, gas: (gas * 125n) / 100n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}

const { WrappedNative, NadcabV2Factory, NadcabV2Router } = artifacts.contracts;
const wnative = await deploy(WrappedNative.abi, WrappedNative.bytecode, ["Wrapped Ether", "WETH"]);
const factory = await deploy(NadcabV2Factory.abi, NadcabV2Factory.bytecode, [account.address, 25n, account.address, 1667n, "Nova LP", "NOVA-LP"]);
const router = await deploy(NadcabV2Router.abi, NadcabV2Router.bytecode, [factory.address, wnative.address]);

const tokens = {};
for (const [symbol, decimals] of [["USDT", 6], ["NOVA", 18], ["GOLD", 18]]) {
  const { address } = await deploy(testToken.abi, testToken.bytecode.object, [symbol, decimals, 0n]);
  await send(address, testToken.abi, "mint", [account.address, parseUnits("100000000", decimals)]);
  await send(address, testToken.abi, "approve", [router.address, maxUint256]);
  tokens[symbol] = { address, decimals };
}

const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const R = NadcabV2Router.abi;
await send(router.address, R, "addLiquidityETH", [tokens.USDT.address, parseUnits("200000", 6), 0n, 0n, account.address, deadline], parseEther("100"));
await send(router.address, R, "addLiquidityETH", [tokens.NOVA.address, parseUnits("500000", 18), 0n, 0n, account.address, deadline], parseEther("50"));
await send(router.address, R, "addLiquidity", [tokens.NOVA.address, tokens.GOLD.address, parseUnits("10000", 18), parseUnits("10", 18), 0n, 0n, account.address, deadline]);

const rounds = Number(process.env.SWAPS || 6);
for (let i = 0; i < rounds; i += 1) {
  await send(router.address, R, "swapExactETHForTokens", [0n, [wnative.address, tokens.USDT.address], account.address, deadline], parseEther("1"));
  await send(router.address, R, "swapExactTokensForETH", [parseUnits("1000", 18), 0n, [tokens.NOVA.address, wnative.address], account.address, deadline]);
  await send(router.address, R, "swapExactTokensForTokens", [parseUnits("100", 6), 0n, [tokens.USDT.address, wnative.address, tokens.NOVA.address], account.address, deadline]);
}

console.log(
  JSON.stringify({
    chainId,
    deployer: account.address,
    startBlock: wnative.block,
    wnative: wnative.address,
    factory: factory.address,
    router: router.address,
    tokens,
  })
);
