import { describe, expect, it } from "vitest";
import { Address, beginCell } from "@ton/core";
import * as Pool from "../src/pool.js";
import {
  EVENT_DEPOSIT,
  EVENT_FACTORY_POOL_CREATED,
  EVENT_POOL_READY,
  EVENT_TON_WITHDRAW,
  EVENT_WITHDRAW,
} from "../src/constants.js";
import {
  parseDepositEventCell,
  parseFactoryPoolCreatedEventCell,
  parseJettonWithdrawalAcceptedEventCell,
  parsePoolReadyEventCell,
  parseTonWithdrawEventCell,
} from "../src/events.js";
import type { Client } from "../src/client.js";

const USER = "EQB8PZ-Cp6UzydbLvjukx1OQL3LmqeYV-tJ3qVMw_mNYgqow";
const TX_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function sparseUpdate(bucketId = 7, newRoot = 0x3333n) {
  return beginCell().storeUint(bucketId, 8).storeUint(newRoot, 256).endCell();
}

function clientWithBodies(
  bodies: string[],
  incomplete: boolean | undefined,
): Client {
  return {
    async getAccountState() {
      throw new Error("unused");
    },
    async runMethod() {
      throw new Error("unused");
    },
    async getTransactions() {
      return {
        ...(incomplete === undefined ? {} : { incomplete }),
        transactions: [{
          lt: "100",
          hash: TX_HASH,
          block_seqno: 10,
          success: true,
          out_msgs: bodies.map((body, index) => ({
            body,
            index,
            isExternal: true,
          })),
        }],
      };
    },
  };
}

describe("pool event codecs", () => {
  it("parses the exact PoolReady event and rejects trailing data", () => {
    const ready = beginCell()
      .storeUint(EVENT_POOL_READY, 32)
      .storeAddress(Address.parse(USER))
      .endCell();
    expect(parsePoolReadyEventCell(ready)).toEqual({
      jettonWallet: Address.parse(USER).toString({
        urlSafe: true,
        bounceable: true,
      }),
    });
    expect(parsePoolReadyEventCell(beginCell()
      .storeSlice(ready.beginParse())
      .storeBit(1)
      .endCell())).toBeNull();
  });

  it("parses Jetton and TON FactoryPoolCreated events exactly", () => {
    const jetton = beginCell()
      .storeUint(EVENT_FACTORY_POOL_CREATED, 32)
      .storeAddress(Address.parse(USER))
      .storeCoins(1_000n)
      .storeAddress(Address.parse(USER))
      .endCell();
    expect(parseFactoryPoolCreatedEventCell(jetton)).toEqual({
      jettonMaster: Address.parse(USER).toString({
        urlSafe: true,
        bounceable: true,
      }),
      denomination: 1_000n,
      poolAddress: Address.parse(USER).toString({
        urlSafe: true,
        bounceable: true,
      }),
    });

    const ton = beginCell()
      .storeUint(EVENT_FACTORY_POOL_CREATED, 32)
      .storeAddress(null)
      .storeCoins(10_000_000_000n)
      .storeAddress(Address.parse(USER))
      .endCell();
    expect(parseFactoryPoolCreatedEventCell(ton)).toMatchObject({
      jettonMaster: null,
      denomination: 10_000_000_000n,
    });
  });

  it("parses the canonical deposit event and sparse root update", async () => {
    const cell = beginCell()
      .storeUint(EVENT_DEPOSIT, 32)
      .storeUint(7, 32)
      .storeUint(0x1111n, 256)
      .storeUint(0x2222n, 256)
      .storeAddress(Address.parse(USER))
      .storeRef(sparseUpdate())
      .endCell();

    expect(parseDepositEventCell(cell)).toEqual({
      leafIndex: 7,
      commitment: 0x1111n,
      newRoot: 0x2222n,
      fromUser: Address.parse(USER).toString({ urlSafe: true, bounceable: true }),
      sparseUpdate: { bucketId: 7, newRoot: 0x3333n },
    });
    await expect(Pool.fetchDepositCommitmentsLegacy(
      clientWithBodies([cell.toBoc().toString("base64")], false),
      "EQdummy",
    )).resolves.toEqual([parseDepositEventCell(cell)]);
  });

  it.each([true, undefined])(
    "refuses a legacy history scan unless completeness is explicit (%s)",
    async (incomplete) => {
      await expect(Pool.fetchDepositCommitmentsLegacy(
        clientWithBodies([], incomplete),
        "EQdummy",
      )).rejects.toThrow(/cannot prove history completeness/);
    },
  );

  it("rejects obsolete prefixes, missing sparse refs and trailing data", () => {
    const obsolete = beginCell()
      .storeUint(EVENT_DEPOSIT, 24)
      .storeUint(7, 32)
      .storeUint(1n, 256)
      .storeUint(2n, 256)
      .storeAddress(Address.parse(USER))
      .storeRef(sparseUpdate())
      .endCell();
    expect(parseDepositEventCell(obsolete)).toBeNull();

    const missing = beginCell()
      .storeUint(EVENT_DEPOSIT, 32)
      .storeUint(7, 32)
      .storeUint(1n, 256)
      .storeUint(2n, 256)
      .storeAddress(Address.parse(USER))
      .endCell();
    expect(parseDepositEventCell(missing)).toBeNull();

    const trailingSparse = beginCell()
      .storeUint(7, 8)
      .storeUint(3n, 256)
      .storeBit(1)
      .endCell();
    const trailing = beginCell()
      .storeUint(EVENT_DEPOSIT, 32)
      .storeUint(7, 32)
      .storeUint(1n, 256)
      .storeUint(2n, 256)
      .storeAddress(Address.parse(USER))
      .storeRef(trailingSparse)
      .endCell();
    expect(parseDepositEventCell(trailing)).toBeNull();
  });

  it("parses TON and Jetton withdrawal events with distinct prefixes", () => {
    const ton = beginCell()
      .storeUint(EVENT_TON_WITHDRAW, 32)
      .storeUint(0x44n, 256)
      .storeAddress(Address.parse(USER))
      .storeCoins(10_000n)
      .storeRef(sparseUpdate(4, 5n))
      .endCell();
    expect(parseTonWithdrawEventCell(ton)).toMatchObject({
      kind: "ton-withdraw",
      nullifierHash: 0x44n,
      payout: 10_000n,
      sparseUpdate: { bucketId: 4, newRoot: 5n },
    });

    const jetton = beginCell()
      .storeUint(EVENT_WITHDRAW, 32)
      .storeUint(91n, 64)
      .storeUint(0x55n, 256)
      .storeAddress(Address.parse(USER))
      .storeCoins(20_000n)
      .storeRef(sparseUpdate(5, 6n))
      .endCell();
    expect(parseJettonWithdrawalAcceptedEventCell(jetton)).toMatchObject({
      kind: "jetton-withdraw",
      clientQueryId: 91n,
      nullifierHash: 0x55n,
      payout: 20_000n,
      sparseUpdate: { bucketId: 5, newRoot: 6n },
    });
  });

});

describe("pool synchronization getters", () => {
  it("passes domain and bucket to sparseRoot", async () => {
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async getTransactions() { return { transactions: [] }; },
      async runMethod(address, method, params) {
        expect(address).toBe("EQpool");
        expect(method).toBe("sparseRoot");
        expect(params).toHaveLength(2);
        expect(params[1]).toBe("42");
        return { exit_code: 0, stack: ["123"] };
      },
    };
    await expect(Pool.readSparseRoot(client, "EQpool", "nullifier", 42))
      .resolves.toBe(123n);
  });
});
