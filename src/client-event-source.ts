import { Cell } from "@ton/core";
import type { Client, RawTx, TransactionCursor } from "./client.js";
import {
  EVENT_DEPOSIT,
  EVENT_TON_WITHDRAW,
  EVENT_WITHDRAW,
} from "./constants.js";
import { parsePoolEventCell } from "./events.js";
import type {
  IndexedPoolEvent,
  MerkleStateEventSource,
} from "./local-state-provider.js";
import type { ReplayPosition } from "./state-provider.js";

export interface ClientEventSourceOptions {
  pageSize?: number;
  maxPages?: number;
}

const STATE_EVENT_OPCODES = new Set([
  EVENT_DEPOSIT,
  EVENT_TON_WITHDRAW,
  EVENT_WITHDRAW,
]);

function isAfterPosition(
  transactionLt: bigint,
  eventIndex: number,
  position: ReplayPosition,
): boolean {
  return transactionLt > position.transactionLt ||
    (transactionLt === position.transactionLt && eventIndex > position.eventIndex);
}

function parseExternalPoolEvent(body: string) {
  let cell: Cell;
  try {
    cell = Cell.fromBase64(body);
  } catch (error) {
    throw new Error("pool external-out message contains an invalid body BOC", {
      cause: error,
    });
  }
  const event = parsePoolEventCell(cell);
  if (
    event === null &&
    !cell.isExotic &&
    cell.bits.length >= 32 &&
    STATE_EVENT_OPCODES.has(cell.beginParse().preloadUint(32))
  ) {
    throw new Error("pool external-out message contains a malformed protocol event");
  }
  return event;
}

const CANONICAL_TRANSACTION_HASH = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

function transactionIdentity(transaction: RawTx): {
  lt: bigint;
  cursor: TransactionCursor;
} {
  if (typeof transaction.success !== "boolean") {
    throw new TypeError("transaction success flag is required for deterministic replay");
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(transaction.lt)) {
    throw new TypeError("transaction LT must be a canonical unsigned decimal string");
  }
  const lt = BigInt(transaction.lt);
  if (lt > 0xffffffffffffffffn) {
    throw new RangeError("transaction LT exceeds uint64");
  }
  if (
    typeof transaction.hash !== "string" ||
    !CANONICAL_TRANSACTION_HASH.test(transaction.hash)
  ) {
    throw new TypeError(
      "transaction hash must be a canonical padded base64 32-byte hash",
    );
  }
  if (!Number.isSafeInteger(transaction.block_seqno) || transaction.block_seqno < 0) {
    throw new RangeError("transaction block_seqno is invalid");
  }
  return { lt, cursor: { lt: transaction.lt, hash: transaction.hash } };
}

/**
 * Adapts a paginated TON RPC client to deterministic pool events. RPC pages
 * may be newest-first; the LocalMerkleStateProvider performs the final
 * `(transactionLt,eventIndex)` ascending sort before replay.
 */
export function createClientEventSource(
  client: Client,
  options: ClientEventSourceOptions = {},
): MerkleStateEventSource {
  const pageSize = options.pageSize ?? 256;
  const maxPages = options.maxPages ?? 10_000;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError("pageSize must be a positive integer");
  }
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new RangeError("maxPages must be a positive integer");
  }

  return {
    async eventsAfter(poolAddress, position) {
      const events: IndexedPoolEvent[] = [];
      let scannedThrough: ReplayPosition | null = null;
      let before: TransactionCursor | undefined;
      let page = 0;
      let reachedCheckpoint = false;

      while (!reachedCheckpoint) {
        if (page >= maxPages) {
          throw new Error("transaction replay exceeded maxPages before checkpoint");
        }
        const response = await client.getTransactions(poolAddress, pageSize, before);
        page += 1;
        if (response.transactions.length === 0) break;

        let oldest: { lt: bigint; cursor: TransactionCursor } | undefined;
        for (const transaction of response.transactions) {
          const identity = transactionIdentity(transaction);
          const { lt } = identity;
          for (const message of transaction.out_msgs ?? []) {
            if (typeof message.isExternal !== "boolean") {
              throw new TypeError(
                "out message isExternal flag is required for deterministic replay",
              );
            }
          }
          const rawHighWater: ReplayPosition = {
            blockSeqno: transaction.block_seqno,
            transactionLt: lt,
            eventIndex: Math.max(
              0,
              ...(transaction.out_msgs ?? []).map((message, index) =>
                message.index ?? index),
            ),
          };
          if (
            scannedThrough === null ||
            rawHighWater.transactionLt > scannedThrough.transactionLt ||
            (rawHighWater.transactionLt === scannedThrough.transactionLt &&
              rawHighWater.eventIndex > scannedThrough.eventIndex)
          ) scannedThrough = rawHighWater;
          if (oldest === undefined || lt < oldest.lt) oldest = identity;
          if (lt < position.transactionLt) {
            reachedCheckpoint = true;
            continue;
          }
          for (const [arrayIndex, message] of (transaction.out_msgs ?? []).entries()) {
            const eventIndex = message.index ?? arrayIndex;
            if (!Number.isSafeInteger(eventIndex) || eventIndex < 0) {
              throw new RangeError("out message event index is invalid");
            }
            if (
              transaction.success !== true ||
              message.isExternal !== true ||
              message.body === undefined
            ) continue;
            const event = parseExternalPoolEvent(message.body);
            if (event !== null) {
              if (isAfterPosition(lt, eventIndex, position)) {
                events.push({
                  position: {
                    blockSeqno: transaction.block_seqno,
                    transactionLt: lt,
                    eventIndex,
                  },
                  event,
                });
              }
            }
          }
        }

        if (
          reachedCheckpoint ||
          response.incomplete === false ||
          (response.incomplete === undefined &&
            response.transactions.length < pageSize)
        ) break;
        if (
          oldest === undefined ||
          (before !== undefined &&
            oldest.cursor.lt === before.lt &&
            oldest.cursor.hash === before.hash) ||
          oldest.lt === 0n
        ) {
          throw new Error("transaction pagination made no progress");
        }
        before = oldest.cursor;
      }
      return {
        events,
        scannedThrough: scannedThrough ?? {
          blockSeqno: 0,
          transactionLt: 0n,
          eventIndex: 0,
        },
      };
    },
  };
}
