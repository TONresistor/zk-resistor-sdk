import { Address, Cell } from "@ton/core";
import {
  EVENT_DEPOSIT,
  EVENT_FACTORY_POOL_CREATED,
  EVENT_POOL_READY,
  EVENT_TON_WITHDRAW,
  EVENT_WITHDRAW,
} from "./constants.js";
import type {
  DepositEvent,
  FactoryPoolCreatedEvent,
  JettonWithdrawalAcceptedEvent,
  PoolReadyEvent,
  SparseSetEventUpdate,
  TonWithdrawEvent,
} from "./types.js";

const ADDRESS_FORMAT = { urlSafe: true, bounceable: true } as const;

function formatAddress(address: Address): string {
  return address.toString(ADDRESS_FORMAT);
}

export function parsePoolReadyEventCell(cell: Cell): PoolReadyEvent | null {
  if (cell.isExotic || cell.refs.length !== 0) return null;
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== EVENT_POOL_READY) return null;
    const event = { jettonWallet: formatAddress(slice.loadAddress()) };
    if (slice.remainingBits !== 0 || slice.remainingRefs !== 0) return null;
    return event;
  } catch {
    return null;
  }
}

export function parseFactoryPoolCreatedEventCell(
  cell: Cell,
): FactoryPoolCreatedEvent | null {
  if (cell.isExotic || cell.refs.length !== 0) return null;
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== EVENT_FACTORY_POOL_CREATED) return null;
    const jettonMaster = slice.loadMaybeAddress();
    const event = {
      jettonMaster: jettonMaster === null ? null : formatAddress(jettonMaster),
      denomination: slice.loadCoins(),
      poolAddress: formatAddress(slice.loadAddress()),
    };
    if (slice.remainingBits !== 0 || slice.remainingRefs !== 0) return null;
    return event;
  } catch {
    return null;
  }
}

function isCanonicalEnd(cell: Cell, bits: number, refs: number): boolean {
  return !cell.isExotic && cell.bits.length === bits && cell.refs.length === refs;
}

export function parseSparseSetEventUpdateCell(
  cell: Cell,
): SparseSetEventUpdate | null {
  if (!isCanonicalEnd(cell, 8 + 256, 0)) return null;
  try {
    const slice = cell.beginParse();
    const update = {
      bucketId: slice.loadUint(8),
      newRoot: slice.loadUintBig(256),
    };
    if (slice.remainingBits !== 0 || slice.remainingRefs !== 0) return null;
    return update;
  } catch {
    return null;
  }
}

export function parseDepositEventCell(cell: Cell): DepositEvent | null {
  if (cell.isExotic || cell.refs.length !== 1) return null;
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== EVENT_DEPOSIT) return null;
    const event: DepositEvent = {
      leafIndex: slice.loadUint(32),
      commitment: slice.loadUintBig(256),
      newRoot: slice.loadUintBig(256),
      fromUser: formatAddress(slice.loadAddress()),
      sparseUpdate: { bucketId: 0, newRoot: 0n },
    };
    event.sparseUpdate = parseSparseSetEventUpdateCell(slice.loadRef()) ??
      (() => { throw new Error("invalid sparse update"); })();
    if (slice.remainingBits !== 0 || slice.remainingRefs !== 0) return null;
    return event;
  } catch {
    return null;
  }
}

export function parseTonWithdrawEventCell(cell: Cell): TonWithdrawEvent | null {
  if (cell.isExotic || cell.refs.length !== 1) return null;
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== EVENT_TON_WITHDRAW) return null;
    const event: TonWithdrawEvent = {
      kind: "ton-withdraw",
      nullifierHash: slice.loadUintBig(256),
      recipient: formatAddress(slice.loadAddress()),
      payout: slice.loadCoins(),
      sparseUpdate: { bucketId: 0, newRoot: 0n },
    };
    event.sparseUpdate = parseSparseSetEventUpdateCell(slice.loadRef()) ??
      (() => { throw new Error("invalid sparse update"); })();
    if (slice.remainingBits !== 0 || slice.remainingRefs !== 0) return null;
    return event;
  } catch {
    return null;
  }
}

export function parseJettonWithdrawalAcceptedEventCell(
  cell: Cell,
): JettonWithdrawalAcceptedEvent | null {
  if (cell.isExotic || cell.refs.length !== 1) return null;
  try {
    const slice = cell.beginParse();
    if (slice.loadUint(32) !== EVENT_WITHDRAW) return null;
    const event: JettonWithdrawalAcceptedEvent = {
      kind: "jetton-withdraw",
      clientQueryId: slice.loadUintBig(64),
      nullifierHash: slice.loadUintBig(256),
      recipient: formatAddress(slice.loadAddress()),
      payout: slice.loadCoins(),
      sparseUpdate: { bucketId: 0, newRoot: 0n },
    };
    event.sparseUpdate = parseSparseSetEventUpdateCell(slice.loadRef()) ??
      (() => { throw new Error("invalid sparse update"); })();
    if (slice.remainingBits !== 0 || slice.remainingRefs !== 0) return null;
    return event;
  } catch {
    return null;
  }
}

export type ParsedPoolEvent =
  | ({ kind: "deposit" } & DepositEvent)
  | TonWithdrawEvent
  | JettonWithdrawalAcceptedEvent;

export function parsePoolEventCell(cell: Cell): ParsedPoolEvent | null {
  if (cell.isExotic || cell.bits.length < 32) return null;
  const prefix = cell.beginParse().preloadUint(32);
  if (prefix === EVENT_DEPOSIT) {
    const event = parseDepositEventCell(cell);
    return event === null ? null : { kind: "deposit", ...event };
  }
  if (prefix === EVENT_TON_WITHDRAW) return parseTonWithdrawEventCell(cell);
  if (prefix === EVENT_WITHDRAW) {
    return parseJettonWithdrawalAcceptedEventCell(cell);
  }
  return null;
}
