import { describe, it, expect } from "vitest";
import { Address, beginCell, Dictionary } from "@ton/core";
import { listPools } from "../src/factory.js";
import type { AccountState, Client } from "../src/client.js";

const FACTORY = "EQCncgvIPeN7jr5Di7TYKUtM_NMYM9ghSm6o3ibxovx1iGPu";
const POOL = "EQDLR324LQ9d9Wj6xYFFb3gTcAkUBM_Sny-osgBhXYI_rM0i";

// Real on-chain storage cell of the mainnet KITO/1000 jetton pool.
const KITO_POOL_DATA =
  "te6cckECCgEAAWIAAkuAFUtmvgPyd7LYj3LGi+BIC8GBjUfRYiMxAJOXs/NeyDQoI8NGAQECAJGAEkWWqh5U7CJUyoU1EUp2L1Yq/OafMhwLYFSFR5RLR37wAp3ILyD3je46+Q4u02ClLTPzTGDPYIUpuqN4m8aL8dYhejUpRAAgA0kAAAACW/j/yw7DmXXJ8sFGlRU6nrP8u4I2BckHXIBZ11eQ+gnwAwQFAgPPwAYHAEOgDgsNciwvVlvqXmQT+ASqF9vmlqRezSCJyiUk+dmeUGHYAgFICAkAQRx2qbybxq0st8E6pb0WK+2Hvbb20qJDs+hbF7DIt22R4ABBFv4/8sOw5l1yfLBRpUVOp6z/LuCNgXJB1yAWddXkPoJgAEq/qh7W71VPRk2CliVlM6TNwFC6bvzE+xw9i1JJBvXjERAAAAAAAEq/gU6BwOD7LGUavvVpZ6fusYgfqEqbo7FHlPT+Fqg757sAAAABXluAQA==";

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
    poolToKey.set(Address.parse(a), BigInt(i + 1));
  });
  const registries = beginCell()
    .storeDict(poolReg)
    .storeDict(poolToKey)
    .storeDict(tonReg)
    .storeDict(tonToKey)
    .endCell();
  return beginCell()
    .storeRef(beginCell().endCell())
    .storeRef(beginCell().endCell())
    .storeUint(jettonPools.length, 32)
    .storeUint(0, 32)
    .storeRef(registries)
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
      client({ status: "active", data: KITO_POOL_DATA }),
      FACTORY,
    );
    expect(pools).toHaveLength(1);
    const p = pools[0]!;
    expect(p.kind).toBe("jetton");
    expect(p.poolAddress).toBe(POOL);
    expect(p.denomination).toBe(1_000_000_000_000n);
    expect(p.nextIndex).toBe(2);
    if (p.kind === "jetton") {
      expect(p.jettonWallet).toBe(
        "EQCqWzXwH5O9lsR7ljRfAkBeDAxqPosRGYgEnL2fmvZBoeJS",
      );
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
