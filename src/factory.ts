import { Address, beginCell, Cell, Dictionary } from "@ton/core";
import { TREE_CAPACITY } from "./constants.js";
import type { Client } from "./client.js";
import {
  assertRunMethodSuccess,
  readBoolean,
  readAddrFromB64,
  readUintNumber,
} from "./stack.js";
import { parseJettonPoolStorage, parseTonPoolStorage } from "./storage.js";
import type { JettonPoolInfo, PoolInfo, TonPoolInfo } from "./types.js";

export interface FactoryRegistries {
  jettonPools: string[];
  tonPools: string[];
}

export interface FactoryStorage extends FactoryRegistries {
  poolCodeHash: string;
  tonPoolCodeHash: string;
  poolCount: number;
  tonPoolCount: number;
  inFlightCreates: number;
  jettonCreateSenders: ReadonlyMap<string, string>;
  tonCreateSenders: ReadonlyMap<string, string>;
}

const ADDRESS_FORMAT = { urlSafe: true, bounceable: true } as const;

export function parseFactoryStorage(dataB64: string): FactoryStorage {
  const root = Cell.fromBase64(dataB64);
  if (root.isExotic || root.bits.length !== 32 + 32 + 16 || root.refs.length !== 3) {
    throw new Error("FactoryStorage root is not canonical");
  }
  const storage = root.beginParse();
  const codesCell = storage.loadRef();
  const poolCount = storage.loadUint(32);
  const tonPoolCount = storage.loadUint(32);
  const inFlightCreates = storage.loadUint(16);
  const registriesCell = storage.loadRef();
  const createSendersCell = storage.loadRef();
  if (storage.remainingBits !== 0 || storage.remainingRefs !== 0) {
    throw new Error("FactoryStorage contains trailing data");
  }

  if (codesCell.isExotic || codesCell.bits.length !== 0 || codesCell.refs.length !== 2) {
    throw new Error("FactoryCodes is not canonical");
  }
  const codes = codesCell.beginParse();
  const poolCode = codes.loadRef();
  const tonPoolCode = codes.loadRef();
  if (codes.remainingBits !== 0 || codes.remainingRefs !== 0) {
    throw new Error("FactoryCodes contains trailing data");
  }

  const registries = registriesCell.beginParse();
  const jettonRegistry = registries.loadDict(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.Address(),
  );
  const poolAddressToKey = registries.loadDict(
    Dictionary.Keys.Address(),
    Dictionary.Values.BigUint(256),
  );
  const tonRegistry = registries.loadDict(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.Address(),
  );
  const tonPoolAddressToKey = registries.loadDict(
    Dictionary.Keys.Address(),
    Dictionary.Values.BigUint(256),
  );
  if (registries.remainingBits !== 0 || registries.remainingRefs !== 0) {
    throw new Error("Factory registries contain trailing data");
  }

  const senders = createSendersCell.beginParse();
  const jettonSenders = senders.loadDict(
    Dictionary.Keys.Address(),
    Dictionary.Values.Address(),
  );
  const tonSenders = senders.loadDict(
    Dictionary.Keys.Address(),
    Dictionary.Values.Address(),
  );
  if (senders.remainingBits !== 0 || senders.remainingRefs !== 0) {
    throw new Error("Factory createSenders contains trailing data");
  }

  if (
    jettonRegistry.size !== poolCount ||
    tonRegistry.size !== tonPoolCount ||
    poolAddressToKey.size !== jettonSenders.size ||
    tonPoolAddressToKey.size !== tonSenders.size ||
    poolAddressToKey.size + tonPoolAddressToKey.size !== inFlightCreates
  ) {
    throw new Error("FactoryStorage counters do not match their registries");
  }

  const fmt = (address: Address) => address.toString(ADDRESS_FORMAT);
  return {
    poolCodeHash: poolCode.hash().toString("hex"),
    tonPoolCodeHash: tonPoolCode.hash().toString("hex"),
    poolCount,
    tonPoolCount,
    inFlightCreates,
    jettonPools: Array.from(jettonRegistry.values()).map(fmt),
    tonPools: Array.from(tonRegistry.values()).map(fmt),
    jettonCreateSenders: new Map(
      Array.from(jettonSenders).map(([pool, creator]) => [fmt(pool), fmt(creator)]),
    ),
    tonCreateSenders: new Map(
      Array.from(tonSenders).map(([pool, creator]) => [fmt(pool), fmt(creator)]),
    ),
  };
}

export async function readRegistries(
  client: Client,
  factoryAddress: string,
): Promise<FactoryRegistries> {
  const acc = await client.getAccountState(factoryAddress);
  if (acc.status !== "active" || !acc.data) {
    return { jettonPools: [], tonPools: [] };
  }
  const storage = parseFactoryStorage(acc.data);
  return {
    jettonPools: storage.jettonPools,
    tonPools: storage.tonPools,
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
  assertRunMethodSuccess(r, "expectedPoolAddress");
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
  assertRunMethodSuccess(r, "poolAddressFor");
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
  assertRunMethodSuccess(r, "expectedTonPoolAddress");
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
  assertRunMethodSuccess(r, "tonPoolAddressFor");
  return readAddrFromB64(r.stack[0] ?? null);
}

export async function poolCount(
  client: Client,
  factoryAddress: string,
): Promise<number> {
  const r = await client.runMethod(factoryAddress, "poolCount", []);
  assertRunMethodSuccess(r, "poolCount");
  return readUintNumber(r.stack[0] ?? null, 32, "poolCount");
}

export async function tonPoolCount(
  client: Client,
  factoryAddress: string,
): Promise<number> {
  const r = await client.runMethod(factoryAddress, "tonPoolCount", []);
  assertRunMethodSuccess(r, "tonPoolCount");
  return readUintNumber(r.stack[0] ?? null, 32, "tonPoolCount");
}

export async function totalPoolCount(
  client: Client,
  factoryAddress: string,
): Promise<number> {
  const r = await client.runMethod(factoryAddress, "totalPoolCount", []);
  assertRunMethodSuccess(r, "totalPoolCount");
  return readUintNumber(r.stack[0] ?? null, 32, "totalPoolCount");
}

export async function inFlightCreateCount(
  client: Client,
  factoryAddress: string,
): Promise<number> {
  const r = await client.runMethod(factoryAddress, "inFlightCreateCount", []);
  assertRunMethodSuccess(r, "inFlightCreateCount");
  return readUintNumber(r.stack[0] ?? null, 16, "inFlightCreateCount");
}

export async function maxFactoryPools(
  client: Client,
  factoryAddress: string,
): Promise<number> {
  const r = await client.runMethod(factoryAddress, "maxFactoryPools", []);
  assertRunMethodSuccess(r, "maxFactoryPools");
  return readUintNumber(r.stack[0] ?? null, 32, "maxFactoryPools");
}

export async function maxInFlightCreates(
  client: Client,
  factoryAddress: string,
): Promise<number> {
  const r = await client.runMethod(factoryAddress, "maxInFlightCreates", []);
  assertRunMethodSuccess(r, "maxInFlightCreates");
  return readUintNumber(r.stack[0] ?? null, 16, "maxInFlightCreates");
}

export async function pendingCreateSender(
  client: Client,
  factoryAddress: string,
  poolAddress: string,
): Promise<string | null> {
  const r = await client.runMethod(factoryAddress, "pendingCreateSender", [
    addressSliceArg(poolAddress),
  ]);
  assertRunMethodSuccess(r, "pendingCreateSender");
  return readAddrFromB64(r.stack[0] ?? null);
}

export async function poolDeploymentPending(
  client: Client,
  factoryAddress: string,
  jettonMaster: string,
  denomination: bigint,
): Promise<boolean> {
  const r = await client.runMethod(factoryAddress, "poolDeploymentPending", [
    addressSliceArg(jettonMaster),
    denomination.toString(),
  ]);
  assertRunMethodSuccess(r, "poolDeploymentPending");
  return readBoolean(r.stack[0] ?? null);
}

export async function tonPoolDeploymentPending(
  client: Client,
  factoryAddress: string,
  denomination: bigint,
): Promise<boolean> {
  const r = await client.runMethod(
    factoryAddress,
    "tonPoolDeploymentPending",
    [denomination.toString()],
  );
  assertRunMethodSuccess(r, "tonPoolDeploymentPending");
  return readBoolean(r.stack[0] ?? null);
}
