import { Address, beginCell } from "@ton/core";
import { describe, expect, it, vi } from "vitest";
import {
  EVENT_DEPOSIT,
} from "../src/constants.js";
import { createClientEventSource } from "../src/client-event-source.js";
import type { Client, RawTx, TransactionCursor } from "../src/client.js";

const USER = Address.parseRaw(`0:${"11".repeat(32)}`);
const TX_HASH_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TX_HASH_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

function depositBody(leafIndex: number, commitment: bigint): string {
  return beginCell()
    .storeUint(EVENT_DEPOSIT, 32)
    .storeUint(leafIndex, 32)
    .storeUint(commitment, 256)
    .storeUint(commitment + 1n, 256)
    .storeAddress(USER)
    .storeRef(beginCell()
      .storeUint(Number(commitment & 0xffn), 8)
      .storeUint(commitment + 2n, 256)
      .endCell())
    .endCell()
    .toBoc()
    .toString("base64");
}

describe("createClientEventSource", () => {
  it("paginates newest-first transactions while preserving LT/message index", async () => {
    const pages: RawTx[][] = [
      [{
        lt: "20",
        hash: TX_HASH_A,
        block_seqno: 2,
        success: true,
        out_msgs: [{ body: depositBody(1, 2n), index: 3, isExternal: true }],
      }],
      [{
        lt: "10",
        hash: TX_HASH_B,
        block_seqno: 1,
        success: true,
        out_msgs: [{ body: depositBody(0, 1n), index: 2, isExternal: true }],
      }],
    ];
    const getTransactions = vi.fn(async (
      _address: string,
      _limit: number,
      before?: TransactionCursor,
    ) => {
      if (before === undefined) return { transactions: pages[0] as RawTx[] };
      expect(before).toEqual({ lt: "20", hash: TX_HASH_A });
      return { transactions: pages[1] as RawTx[], incomplete: false };
    });
    const client: Client = {
      getTransactions,
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
    };
    const batch = await createClientEventSource(client, { pageSize: 1 }).eventsAfter("EQpool", {
      blockSeqno: 0,
      transactionLt: 0n,
      eventIndex: 0,
    });
    expect(batch.events.map(({ position, event }) => ({
      lt: position.transactionLt,
      block: position.blockSeqno,
      index: position.eventIndex,
      leafIndex: event.kind === "deposit" ? event.leafIndex : -1,
    }))).toEqual([
      { lt: 20n, block: 2, index: 3, leafIndex: 1 },
      { lt: 10n, block: 1, index: 2, leafIndex: 0 },
    ]);
    expect(getTransactions).toHaveBeenCalledTimes(2);
  });

  it("continues an explicitly incomplete short page", async () => {
    const getTransactions = vi.fn(async (
      _address: string,
      _limit: number,
      before?: TransactionCursor,
    ) => before === undefined
      ? {
          incomplete: true,
          transactions: [{
            lt: "20",
            hash: TX_HASH_A,
            block_seqno: 2,
            success: true,
            out_msgs: [{ body: depositBody(1, 2n), index: 0, isExternal: true }],
          }],
        }
      : {
          incomplete: false,
          transactions: [{
            lt: "10",
            hash: TX_HASH_B,
            block_seqno: 1,
            success: true,
            out_msgs: [{ body: depositBody(0, 1n), index: 0, isExternal: true }],
          }],
        });
    const client: Client = {
      getTransactions,
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
    };
    const batch = await createClientEventSource(client, { pageSize: 2 })
      .eventsAfter("EQpool", {
        blockSeqno: 0,
        transactionLt: 0n,
        eventIndex: 0,
      });
    expect(batch.events).toHaveLength(2);
    expect(getTransactions).toHaveBeenNthCalledWith(2, "EQpool", 2, {
      lt: "20",
      hash: TX_HASH_A,
    });
  });

  it("uses the complete identity of the oldest transaction in a page", async () => {
    const getTransactions = vi.fn(async (
      _address: string,
      _limit: number,
      before?: TransactionCursor,
    ) => {
      if (before === undefined) {
        return {
          incomplete: true,
          transactions: [
            {
              lt: "30",
              hash: TX_HASH_A,
              block_seqno: 3,
              success: true,
              out_msgs: [],
            },
            {
              lt: "20",
              hash: TX_HASH_B,
              block_seqno: 2,
              success: true,
              out_msgs: [],
            },
          ],
        };
      }
      expect(before).toEqual({ lt: "20", hash: TX_HASH_B });
      return { transactions: [], incomplete: false };
    });
    const client: Client = {
      getTransactions,
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
    };

    await createClientEventSource(client, { pageSize: 2 }).eventsAfter("EQpool", {
      blockSeqno: 0,
      transactionLt: 0n,
      eventIndex: 0,
    });
    expect(getTransactions).toHaveBeenCalledTimes(2);
  });

  it("tracks pagination progress by the complete LT/hash identity", async () => {
    const getTransactions = vi.fn(async (
      _address: string,
      _limit: number,
      before?: TransactionCursor,
    ) => {
      if (before === undefined) {
        return {
          incomplete: true,
          transactions: [{
            lt: "20",
            hash: TX_HASH_A,
            block_seqno: 2,
            success: true,
            out_msgs: [],
          }],
        };
      }
      if (before.hash === TX_HASH_A) {
        return {
          incomplete: true,
          transactions: [{
            lt: "20",
            hash: TX_HASH_B,
            block_seqno: 2,
            success: true,
            out_msgs: [],
          }],
        };
      }
      expect(before).toEqual({ lt: "20", hash: TX_HASH_B });
      return { transactions: [], incomplete: false };
    });
    const client: Client = {
      getTransactions,
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
    };

    await expect(createClientEventSource(client, { pageSize: 1 })
      .eventsAfter("EQpool", {
        blockSeqno: 0,
        transactionLt: 0n,
        eventIndex: 0,
      })).resolves.toMatchObject({ events: [] });
    expect(getTransactions).toHaveBeenCalledTimes(3);
  });

  it("fails closed when an RPC page cannot provide a transaction hash", async () => {
    const client = {
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
      async getTransactions() {
        return {
          incomplete: true,
          transactions: [{
            lt: "20",
            block_seqno: 2,
            success: true,
            out_msgs: [],
          }],
        };
      },
    } as unknown as Client;

    await expect(createClientEventSource(client, { pageSize: 1 })
      .eventsAfter("EQpool", {
        blockSeqno: 0,
        transactionLt: 0n,
        eventIndex: 0,
      })).rejects.toThrow(/transaction hash must be a canonical padded base64/);
  });

  it("fails closed when pagination does not advance", async () => {
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
      async getTransactions() {
        return {
          incomplete: true,
          transactions: [{
            lt: "20",
            hash: TX_HASH_A,
            block_seqno: 2,
            success: true,
            out_msgs: [],
          }],
        };
      },
    };
    await expect(createClientEventSource(client, { pageSize: 1 })
      .eventsAfter("EQpool", {
        blockSeqno: 0,
        transactionLt: 0n,
        eventIndex: 0,
      })).rejects.toThrow(/pagination made no progress/);
  });

  it("fails closed at maxPages before reaching the checkpoint", async () => {
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
      async getTransactions() {
        return {
          incomplete: true,
          transactions: [{
            lt: "20",
            hash: TX_HASH_A,
            block_seqno: 2,
            success: true,
            out_msgs: [],
          }],
        };
      },
    };
    await expect(createClientEventSource(client, { pageSize: 1, maxPages: 1 })
      .eventsAfter("EQpool", {
        blockSeqno: 0,
        transactionLt: 0n,
        eventIndex: 0,
      })).rejects.toThrow(/exceeded maxPages/);
  });

  it("does not replay event indexes already covered by the checkpoint", async () => {
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
      async getTransactions() {
        return {
          transactions: [{
            lt: "10",
            hash: TX_HASH_A,
            block_seqno: 1,
            success: true,
            out_msgs: [
              { body: depositBody(0, 1n), index: 0, isExternal: true },
              { body: depositBody(1, 2n), index: 1, isExternal: true },
            ],
          }],
        };
      },
    };
    const batch = await createClientEventSource(client).eventsAfter("EQpool", {
      blockSeqno: 1,
      transactionLt: 10n,
      eventIndex: 0,
    });
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.position.eventIndex).toBe(1);
  });

  it("advances the scan cursor across transactions with no recognized event", async () => {
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
      async getTransactions() {
        return {
          incomplete: false,
          transactions: [
            {
              lt: "20",
              hash: TX_HASH_A,
              block_seqno: 2,
              success: true,
              out_msgs: [],
            },
            {
              lt: "10",
              hash: TX_HASH_B,
              block_seqno: 1,
              success: true,
              out_msgs: [{ body: depositBody(0, 1n), index: 0, isExternal: true }],
            },
          ],
        };
      },
    };
    const batch = await createClientEventSource(client).eventsAfter("EQpool", {
      blockSeqno: 0,
      transactionLt: 0n,
      eventIndex: 0,
    });
    expect(batch.events).toHaveLength(1);
    expect(batch.scannedThrough).toEqual({
      blockSeqno: 2,
      transactionLt: 20n,
      eventIndex: 0,
    });
  });

  it("ignores protocol-looking out messages from failed transactions", async () => {
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
      async getTransactions() {
        return { transactions: [{
          lt: "10",
          hash: TX_HASH_A,
          block_seqno: 1,
          success: false,
          out_msgs: [{ body: depositBody(0, 1n), index: 0, isExternal: true }],
        }], incomplete: false };
      },
    };
    const batch = await createClientEventSource(client).eventsAfter("EQpool", {
      blockSeqno: 0,
      transactionLt: 0n,
      eventIndex: 0,
    });
    expect(batch.events).toEqual([]);
    expect(batch.scannedThrough.transactionLt).toBe(10n);
  });

  it("fails closed on malformed known external events", async () => {
    const malformed = beginCell().storeUint(EVENT_DEPOSIT, 32).endCell();
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
      async getTransactions() {
        return { transactions: [{
          lt: "10",
          hash: TX_HASH_A,
          block_seqno: 1,
          success: true,
          out_msgs: [{
            body: malformed.toBoc().toString("base64"),
            index: 0,
            isExternal: true,
          }],
        }], incomplete: false };
      },
    };
    await expect(createClientEventSource(client).eventsAfter("EQpool", {
      blockSeqno: 0,
      transactionLt: 0n,
      eventIndex: 0,
    })).rejects.toThrow(/malformed protocol event/);
  });

  it("fails fast when a legacy adapter omits replay classification flags", async () => {
    const legacyClient = {
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
      async getTransactions() {
        return { transactions: [{
          lt: "10",
          hash: TX_HASH_A,
          block_seqno: 1,
          success: true,
          out_msgs: [{ body: depositBody(0, 1n), index: 0 }],
        }] };
      },
    } as unknown as Client;
    await expect(createClientEventSource(legacyClient).eventsAfter("EQpool", {
      blockSeqno: 0,
      transactionLt: 0n,
      eventIndex: 0,
    })).rejects.toThrow(/isExternal flag is required/);

    const missingSuccess = {
      ...legacyClient,
      async getTransactions() {
        return {
          transactions: [{
            lt: "10",
            hash: TX_HASH_A,
            block_seqno: 1,
            out_msgs: [],
          }],
        };
      },
    } as unknown as Client;
    await expect(createClientEventSource(missingSuccess).eventsAfter("EQpool", {
      blockSeqno: 0,
      transactionLt: 0n,
      eventIndex: 0,
    })).rejects.toThrow(/success flag is required/);
  });

  it("does not trust the requested cursor when the RPC returns no transaction", async () => {
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async runMethod() { throw new Error("unused"); },
      async getTransactions() { return { transactions: [], incomplete: false }; },
    };
    const batch = await createClientEventSource(client).eventsAfter("EQpool", {
      blockSeqno: 999,
      transactionLt: 999n,
      eventIndex: 9,
    });
    expect(batch.scannedThrough).toEqual({
      blockSeqno: 0,
      transactionLt: 0n,
      eventIndex: 0,
    });
  });
});
