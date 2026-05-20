import { describe, it, expect } from "vitest";
import { Address, beginCell, Dictionary } from "@ton/core";
import { readRegistries } from "../src/factory.js";
import type { AccountState, Client } from "../src/client.js";

const FACTORY = "EQCncgvIPeN7jr5Di7TYKUtM_NMYM9ghSm6o3ibxovx1iGPu";
const POOL_A = Address.parse("EQABoe2lCyE_HCq48GinrdEKn3iifaiivxsl82W7ws3vG9sM");
const POOL_B = Address.parse("EQBh2E7Tc_OKGOl6Y20UgwXYx_79XnqCwzS7YgcQqQUUXvpW");
const TON_POOL = Address.parse(FACTORY);

const fmt = (a: Address) => a.toString({ urlSafe: true, bounceable: true });

// Builds a FactoryStorage cell in the exact ref/bit order the Tolk contract
// uses; this layout is what readRegistries is verified against.
function mockFactoryData(jettonPools: Address[], tonPools: Address[]): string {
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
    poolReg.set(BigInt(i + 1), a);
    poolToKey.set(a, BigInt(i + 1));
  });
  tonPools.forEach((a, i) => {
    tonReg.set(BigInt(i + 1), a);
    tonToKey.set(a, BigInt(i + 1));
  });

  const registries = beginCell()
    .storeDict(poolReg)
    .storeDict(poolToKey)
    .storeDict(tonReg)
    .storeDict(tonToKey)
    .endCell();

  return beginCell()
    .storeRef(beginCell().endCell()) // poolCode
    .storeRef(beginCell().endCell()) // tonPoolCode
    .storeUint(jettonPools.length, 32) // poolCount
    .storeUint(tonPools.length, 32) // tonPoolCount
    .storeRef(registries)
    .endCell()
    .toBoc()
    .toString("base64");
}

function mockClient(acc: AccountState): Client {
  return {
    async getAccountState() {
      return acc;
    },
    async runMethod() {
      throw new Error("runMethod not used by readRegistries");
    },
    async getTransactions() {
      return { transactions: [] };
    },
  };
}

describe("readRegistries", () => {
  it("parses jetton and TON pool addresses", async () => {
    const client = mockClient({
      status: "active",
      data: mockFactoryData([POOL_A, POOL_B], [TON_POOL]),
    });
    const r = await readRegistries(client, FACTORY);
    expect(r.jettonPools).toHaveLength(2);
    expect(r.jettonPools).toContain(fmt(POOL_A));
    expect(r.jettonPools).toContain(fmt(POOL_B));
    expect(r.tonPools).toEqual([fmt(TON_POOL)]);
  });

  it("handles an empty factory", async () => {
    const client = mockClient({
      status: "active",
      data: mockFactoryData([], []),
    });
    const r = await readRegistries(client, FACTORY);
    expect(r).toEqual({ jettonPools: [], tonPools: [] });
  });

  it("returns empty for an uninitialized account", async () => {
    const client = mockClient({ status: "uninitialized" });
    const r = await readRegistries(client, FACTORY);
    expect(r).toEqual({ jettonPools: [], tonPools: [] });
  });
});
