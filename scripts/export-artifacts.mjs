#!/usr/bin/env node
// Writes artifacts/nadcab-v2.json (ABI + creation bytecode) from the Foundry build, for the web app and the Console.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "contracts/out");
const read = (file, name) => JSON.parse(readFileSync(join(out, file, `${name}.json`), "utf8"));

const contracts = {};
for (const [file, name, withBytecode] of [
  ["WrappedNative.sol", "WrappedNative", true],
  ["NadcabV2Factory.sol", "NadcabV2Factory", true],
  ["NadcabV2Router.sol", "NadcabV2Router", true],
  ["NadcabV2Pair.sol", "NadcabV2Pair", false],
]) {
  const artifact = read(file, name);
  contracts[name] = { abi: artifact.abi, ...(withBytecode ? { bytecode: artifact.bytecode.object } : {}) };
}
const factory = read("NadcabV2Factory.sol", "NadcabV2Factory");
const pair = read("NadcabV2Pair.sol", "NadcabV2Pair");

const payload = {
  name: "Nadcab AMM v2",
  compiler: factory.metadata?.compiler?.version || "0.8.24",
  evmVersion: "paris",
  pairBytecodeLength: (pair.bytecode.object.length - 2) / 2,
  contracts,
};
mkdirSync(join(root, "artifacts"), { recursive: true });
writeFileSync(join(root, "artifacts/nadcab-v2.json"), `${JSON.stringify(payload)}\n`);
console.log(`artifacts/nadcab-v2.json: ${Object.keys(contracts).join(", ")}`);
