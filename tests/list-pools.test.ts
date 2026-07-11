import { describe, it, expect } from "vitest";
import { Address, beginCell, Dictionary } from "@ton/core";
import { listPools } from "../src/factory.js";
import type { AccountState, Client } from "../src/client.js";

const FACTORY = "EQCncgvIPeN7jr5Di7TYKUtM_NMYM9ghSm6o3ibxovx1iGPu";
const POOL = "EQDLR324LQ9d9Wj6xYFFb3gTcAkUBM_Sny-osgBhXYI_rM0i";

const JETTON_MASTER = Address.parseRaw(`0:${"11".repeat(32)}`);
const POOL_FACTORY = Address.parse(FACTORY);
const JETTON_WALLET = Address.parseRaw(`0:${"33".repeat(32)}`);

function poolData(): string {
  const identity = beginCell()
    .storeAddress(JETTON_MASTER)
    .storeAddress(POOL_FACTORY)
    .storeCoins(1_000_000_000_000n)
    .endCell();
  const merkle = beginCell().storeUint(2, 32).storeUint(7n, 256).endCell();
  return beginCell()
    .storeRef(identity)
    .storeAddress(JETTON_WALLET)
    .storeCoins(300_000_000n)
    .storeRef(merkle)
    .storeUint(1, 32)
    .endCell()
    .toBoc()
    .toString("base64");
}

function factoryData(jettonPools: string[]): string {
  const poolReg = Dictionary.empty(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.Address(),
  );
  const poolToKey = Dictionary.empty(
    Dictionary.Keys.Address(),
    Dictionary.Values.BigUint(256),
  );
  const tonReg = Dictionary.empty(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.Address(),
  );
  const tonToKey = Dictionary.empty(
    Dictionary.Keys.Address(),
    Dictionary.Values.BigUint(256),
  );
  jettonPools.forEach((a, i) => {
    poolReg.set(BigInt(i + 1), Address.parse(a));
  });
  const registries = beginCell()
    .storeDict(poolReg)
    .storeDict(poolToKey)
    .storeDict(tonReg)
    .storeDict(tonToKey)
    .endCell();
  const codes = beginCell()
    .storeRef(beginCell().storeUint(1, 1).endCell())
    .storeRef(beginCell().storeUint(2, 2).endCell())
    .endCell();
  const createSenders = beginCell()
    .storeDict(Dictionary.empty(
      Dictionary.Keys.Address(),
      Dictionary.Values.Address(),
    ))
    .storeDict(Dictionary.empty(
      Dictionary.Keys.Address(),
      Dictionary.Values.Address(),
    ))
    .endCell();
  return beginCell()
    .storeRef(codes)
    .storeUint(jettonPools.length, 32)
    .storeUint(0, 32)
    .storeUint(0, 16)
    .storeRef(registries)
    .storeRef(createSenders)
    .endCell()
    .toBoc()
    .toString("base64");
}

function client(pool: AccountState | (() => Promise<AccountState>)): Client {
  return {
    async getAccountState(address) {
      if (address === FACTORY) {
        return { status: "active", data: factoryData([POOL]) };
      }
      return typeof pool === "function" ? pool() : pool;
    },
    async runMethod() {
      throw new Error("runMethod not used by listPools");
    },
    async getTransactions() {
      return { transactions: [] };
    },
  };
}

describe("listPools", () => {
  it("decodes a pool from its on-chain storage cell", async () => {
    const pools = await listPools(
      client({ status: "active", data: poolData() }),
      FACTORY,
    );
    expect(pools).toHaveLength(1);
    const p = pools[0]!;
    expect(p.kind).toBe("jetton");
    expect(p.poolAddress).toBe(POOL);
    expect(p.denomination).toBe(1_000_000_000_000n);
    expect(p.nextIndex).toBe(2);
    if (p.kind === "jetton") {
      expect(p.jettonWallet).toBe(JETTON_WALLET.toString({
        urlSafe: true,
        bounceable: true,
      }));
    }
  });

  it("skips a pool whose account is uninitialized", async () => {
    const pools = await listPools(client({ status: "uninitialized" }), FACTORY);
    expect(pools).toEqual([]);
  });

  it("propagates a read failure instead of dropping the pool", async () => {
    const failing = client(async () => {
      throw new Error("RPC request failed: status=429");
    });
    await expect(listPools(failing, FACTORY)).rejects.toThrow("429");
  });
});
