import { Address, beginCell, Cell, Dictionary } from "@ton/core";
import { TREE_CAPACITY } from "./constants.js";
import type { Client } from "./client.js";
import { readBigInt, readAddrFromB64 } from "./stack.js";
import { parseJettonPoolStorage, parseTonPoolStorage } from "./storage.js";
import type { JettonPoolInfo, PoolInfo, TonPoolInfo } from "./types.js";

interface FactoryRegistries {
  jettonPools: string[];
  tonPools: string[];
}

export async function readRegistries(
  client: Client,
  factoryAddress: string,
): Promise<FactoryRegistries> {
  const acc = await client.getAccountState(factoryAddress);
  if (acc.status !== "active" || !acc.data) {
    return { jettonPools: [], tonPools: [] };
  }
  // FactoryStorage: refs [poolCode, tonPoolCode, registries];
  // bits [poolCount:uint32, tonPoolCount:uint32].
  const cs = Cell.fromBase64(acc.data).beginParse();
  cs.loadRef();
  cs.loadRef();
  cs.loadUint(32);
  cs.loadUint(32);
  // Registries sub-cell holds four dicts; only the two forward registries
  // (key -> pool address) are needed to enumerate.
  const reg = cs.loadRef().beginParse();
  const jettonRegistry = reg.loadDict(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.Address(),
  );
  reg.loadDict(Dictionary.Keys.Address(), Dictionary.Values.BigUint(256));
  const tonRegistry = reg.loadDict(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.Address(),
  );

  const fmt = (a: Address) => a.toString({ urlSafe: true, bounceable: true });
  return {
    jettonPools: Array.from(jettonRegistry.values()).map(fmt),
    tonPools: Array.from(tonRegistry.values()).map(fmt),
  };
}

const POOL_READ_CONCURRENCY = 4;

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export interface JettonMeta {
  symbol: string;
  decimals: number;
  name: string | null;
  image: string | null;
}

export interface ListPoolsOptions {
  resolveJettonMeta?: (jettonMaster: string) => Promise<JettonMeta>;
}

// Per pool: one getAccountState plus a local storage decode. Network errors
// propagate; a genuinely uninitialized account is skipped.
export async function listPools(
  client: Client,
  factoryAddress: string,
  options: ListPoolsOptions = {},
): Promise<PoolInfo[]> {
  const { jettonPools, tonPools } = await readRegistries(client, factoryAddress);
  const meta = options.resolveJettonMeta ?? defaultJettonMeta;

  const jettonResults = await mapWithLimit(
    jettonPools,
    POOL_READ_CONCURRENCY,
    async (poolAddress): Promise<PoolInfo | null> => {
      const acc = await client.getAccountState(poolAddress);
      if (acc.status !== "active" || !acc.data) return null;
      const s = parseJettonPoolStorage(acc.data);
      const m = await meta(s.jettonMaster);
      const info: JettonPoolInfo = {
        kind: "jetton",
        poolAddress,
        jettonMaster: s.jettonMaster,
        jettonSymbol: m.symbol,
        jettonDecimals: m.decimals,
        jettonImage: m.image,
        jettonName: m.name,
        denomination: s.denomination,
        nextIndex: s.nextIndex,
        capacity: TREE_CAPACITY,
        currentRoot: s.currentRoot,
        jettonWallet: s.jettonWallet,
      };
      return info;
    },
  );

  const tonResults = await mapWithLimit(
    tonPools,
    POOL_READ_CONCURRENCY,
    async (poolAddress): Promise<PoolInfo | null> => {
      const acc = await client.getAccountState(poolAddress);
      if (acc.status !== "active" || !acc.data) return null;
      const s = parseTonPoolStorage(acc.data);
      const info: TonPoolInfo = {
        kind: "ton",
        poolAddress,
        denomination: s.denomination,
        nextIndex: s.nextIndex,
        capacity: TREE_CAPACITY,
        currentRoot: s.currentRoot,
        pendingWithdrawTon: s.pendingWithdrawTon,
      };
      return info;
    },
  );

  return [...tonResults, ...jettonResults]
    .filter((p): p is PoolInfo => p !== null)
    .sort(comparePools);
}

function comparePools(a: PoolInfo, b: PoolInfo): number {
  if (a.kind !== b.kind) return a.kind === "ton" ? -1 : 1;
  if (a.kind === "ton" && b.kind === "ton") {
    const d = a.denomination - b.denomination;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  if (a.kind === "jetton" && b.kind === "jetton") {
    if (a.jettonSymbol !== b.jettonSymbol)
      return a.jettonSymbol.localeCompare(b.jettonSymbol);
    const d = a.denomination - b.denomination;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  return 0;
}

function defaultJettonMeta(jettonMaster: string): Promise<JettonMeta> {
  return Promise.resolve({
    symbol: jettonMaster.slice(0, 6) + "..." + jettonMaster.slice(-4),
    decimals: 9,
    name: null,
    image: null,
  });
}

function addressSliceArg(address: string): { type: "slice"; boc: string } {
  return {
    type: "slice",
    boc: beginCell()
      .storeAddress(Address.parse(address))
      .endCell()
      .toBoc()
      .toString("base64"),
  };
}

export async function expectedPoolAddress(
  client: Client,
  factoryAddress: string,
  jettonMaster: string,
  denomination: bigint,
): Promise<string> {
  const r = await client.runMethod(factoryAddress, "expectedPoolAddress", [
    addressSliceArg(jettonMaster),
    denomination.toString(),
  ]);
  const addr = readAddrFromB64(r.stack[0] ?? null);
  if (!addr) throw new Error("expectedPoolAddress: factory returned no address");
  return addr;
}

export async function poolAddressFor(
  client: Client,
  factoryAddress: string,
  jettonMaster: string,
  denomination: bigint,
): Promise<string | null> {
  const r = await client.runMethod(factoryAddress, "poolAddressFor", [
    addressSliceArg(jettonMaster),
    denomination.toString(),
  ]);
  return readAddrFromB64(r.stack[0] ?? null);
}

export async function expectedTonPoolAddress(
  client: Client,
  factoryAddress: string,
  denomination: bigint,
): Promise<string> {
  const r = await client.runMethod(factoryAddress, "expectedTonPoolAddress", [
    denomination.toString(),
  ]);
  const addr = readAddrFromB64(r.stack[0] ?? null);
  if (!addr)
    throw new Error("expectedTonPoolAddress: factory returned no address");
  return addr;
}

export async function tonPoolAddressFor(
  client: Client,
  factoryAddress: string,
  denomination: bigint,
): Promise<string | null> {
  const r = await client.runMethod(factoryAddress, "tonPoolAddressFor", [
    denomination.toString(),
  ]);
  return readAddrFromB64(r.stack[0] ?? null);
}

export async function poolCount(
  client: Client,
  factoryAddress: string,
): Promise<number> {
  const r = await client.runMethod(factoryAddress, "poolCount", []);
  return Number(readBigInt(r.stack[0] ?? null));
}

export async function tonPoolCount(
  client: Client,
  factoryAddress: string,
): Promise<number> {
  const r = await client.runMethod(factoryAddress, "tonPoolCount", []);
  return Number(readBigInt(r.stack[0] ?? null));
}
