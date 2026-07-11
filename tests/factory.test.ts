import { describe, it, expect } from "vitest";
import { Address, beginCell, Dictionary } from "@ton/core";
import { parseFactoryStorage, readRegistries } from "../src/factory.js";
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
  });
  tonPools.forEach((a, i) => {
    tonReg.set(BigInt(i + 1), a);
  });

  const registries = beginCell()
    .storeDict(poolReg)
    .storeDict(poolToKey)
    .storeDict(tonReg)
    .storeDict(tonToKey)
    .endCell();
  const poolCode = beginCell().storeUint(1, 1).endCell();
  const tonPoolCode = beginCell().storeUint(2, 2).endCell();
  const codes = beginCell()
    .storeRef(poolCode)
    .storeRef(tonPoolCode)
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
    .storeUint(jettonPools.length, 32) // poolCount
    .storeUint(tonPools.length, 32) // tonPoolCount
    .storeUint(0, 16) // inFlightCreates
    .storeRef(registries)
    .storeRef(createSenders)
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

  it("decodes the exact code bundle, counters and sub-cells", () => {
    const parsed = parseFactoryStorage(
      mockFactoryData([POOL_A, POOL_B], [TON_POOL]),
    );
    expect(parsed.poolCount).toBe(2);
    expect(parsed.tonPoolCount).toBe(1);
    expect(parsed.inFlightCreates).toBe(0);
    expect(parsed.poolCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.tonPoolCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.jettonCreateSenders.size).toBe(0);
    expect(parsed.tonCreateSenders.size).toBe(0);
  });

  it("rejects the legacy two-code FactoryStorage layout", () => {
    const legacy = beginCell()
      .storeRef(beginCell().endCell())
      .storeRef(beginCell().endCell())
      .storeUint(0, 32)
      .storeUint(0, 32)
      .storeRef(beginCell().endCell())
      .endCell()
      .toBoc()
      .toString("base64");
    expect(() => parseFactoryStorage(legacy)).toThrow(/FactoryStorage root/);
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
