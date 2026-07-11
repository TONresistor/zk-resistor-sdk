import { Cell } from "@ton/core";
import { BLS12_381_R } from "./constants.js";
import type { Client } from "./client.js";
import {
  createClientEventSource,
  type ClientEventSourceOptions,
} from "./client-event-source.js";
import type { MerkleStateEventSource } from "./local-state-provider.js";
import { parseDepositEventCell } from "./events.js";
import {
  assertRunMethodSuccess,
  cellSliceArg,
  readAddrFromB64,
  readBigInt,
  readBoolean,
  readUintNumber,
} from "./stack.js";
import { sparseSetDomain } from "./state-provider.js";
import { parseJettonPoolStorage } from "./storage.js";
import type { DepositEvent, JettonPoolState } from "./types.js";
import type {
  MerkleStateChainReader,
  MerkleStateSyncTarget,
  SparseSetId,
} from "./state-provider.js";

export async function readState(
  client: Client,
  poolAddress: string,
): Promise<JettonPoolState> {
  const acc = await client.getAccountState(poolAddress);
  if (acc.status !== "active" || !acc.data) {
    throw new Error(
      `Pool ${poolAddress} is not active (status: ${acc.status}).`,
    );
  }
  const s = parseJettonPoolStorage(acc.data);
  return {
    currentRoot: s.currentRoot,
    nextIndex: s.nextIndex,
    denomination: s.denomination,
    jettonWallet: s.jettonWallet,
    relayerReserve: s.relayerReserve,
    withdrawalCount: s.withdrawalCount,
  };
}

export type PoolEventSourceOptions = ClientEventSourceOptions;

export async function createEventSource(
  client: Client,
  poolAddress: string,
  options: PoolEventSourceOptions = {},
): Promise<MerkleStateEventSource> {
  return createClientEventSource(client, options);
}

export async function readSparseRoot(
  client: Client,
  poolAddress: string,
  setId: SparseSetId,
  bucketId: number,
): Promise<bigint> {
  if (!Number.isInteger(bucketId) || bucketId < 0 || bucketId > 255) {
    throw new RangeError("bucketId must be a uint8");
  }
  const result = await client.runMethod(poolAddress, "sparseRoot", [
    sparseSetDomain(setId).toString(),
    bucketId.toString(),
  ]);
  assertRunMethodSuccess(result, "sparseRoot");
  return readBigInt(result.stack[0] ?? null);
}

async function readRequiredAddress(
  client: Client,
  poolAddress: string,
  method: string,
): Promise<string> {
  const result = await client.runMethod(poolAddress, method, []);
  assertRunMethodSuccess(result, method);
  const address = readAddrFromB64(result.stack[0] ?? null);
  if (address === null) throw new Error(`${method}: Pool returned no address`);
  return address;
}

async function readNumericGetter(
  client: Client,
  poolAddress: string,
  method: string,
): Promise<bigint> {
  const result = await client.runMethod(poolAddress, method, []);
  assertRunMethodSuccess(result, method);
  return readBigInt(result.stack[0] ?? null);
}

export function readJettonMaster(
  client: Client,
  poolAddress: string,
): Promise<string> {
  return readRequiredAddress(client, poolAddress, "jettonMaster");
}

export function readFactory(
  client: Client,
  poolAddress: string,
): Promise<string> {
  return readRequiredAddress(client, poolAddress, "factory");
}

export async function readJettonWallet(
  client: Client,
  poolAddress: string,
): Promise<string | null> {
  const result = await client.runMethod(poolAddress, "jettonWallet", []);
  assertRunMethodSuccess(result, "jettonWallet");
  return readAddrFromB64(result.stack[0] ?? null);
}

export function readDenomination(
  client: Client,
  poolAddress: string,
): Promise<bigint> {
  return readNumericGetter(client, poolAddress, "denomination");
}

export function readCurrentRoot(
  client: Client,
  poolAddress: string,
): Promise<bigint> {
  return readNumericGetter(client, poolAddress, "currentRoot");
}

export async function readNextIndex(
  client: Client,
  poolAddress: string,
): Promise<number> {
  const result = await client.runMethod(poolAddress, "nextIndex", []);
  assertRunMethodSuccess(result, "nextIndex");
  return readUintNumber(result.stack[0] ?? null, 32, "nextIndex");
}

export function readRelayerReserve(
  client: Client,
  poolAddress: string,
): Promise<bigint> {
  return readNumericGetter(client, poolAddress, "relayerReserve");
}

export async function readWithdrawalCount(
  client: Client,
  poolAddress: string,
): Promise<number> {
  const result = await client.runMethod(poolAddress, "withdrawalCount", []);
  assertRunMethodSuccess(result, "withdrawalCount");
  return readUintNumber(result.stack[0] ?? null, 32, "withdrawalCount");
}

export async function readRentRunway(
  client: Client,
  poolAddress: string,
): Promise<bigint> {
  const result = await client.runMethod(poolAddress, "rentRunway", []);
  assertRunMethodSuccess(result, "rentRunway");
  return readBigInt(result.stack[0] ?? null);
}

export async function readTreeDepth(
  client: Client,
  poolAddress: string,
): Promise<number> {
  const result = await client.runMethod(poolAddress, "treeDepth", []);
  assertRunMethodSuccess(result, "treeDepth");
  const value = readBigInt(result.stack[0] ?? null);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("treeDepth getter returned an invalid value");
  }
  return Number(value);
}

function assertFieldElement(name: string, value: bigint): void {
  if (value < 0n || value >= BLS12_381_R) {
    throw new RangeError(`${name} must be a BLS12-381 scalar field element`);
  }
}

function proofPointArgs(proofCell: Cell) {
  if (proofCell.isExotic || proofCell.bits.length !== 0 || proofCell.refs.length !== 3) {
    throw new Error("proofCell is not a canonical Groth16 proof");
  }
  const expectedBits = [384, 768, 384] as const;
  return proofCell.refs.map((point, index) => {
    if (
      point.isExotic ||
      point.bits.length !== expectedBits[index] ||
      point.refs.length !== 0
    ) {
      throw new Error("proofCell is not a canonical Groth16 proof");
    }
    return cellSliceArg(point);
  });
}

export interface PreviewInsertProofOptions {
  oldRoot: bigint;
  newRoot: bigint;
  commitment: bigint;
  leafIndex: number;
  proofCell: Cell;
}

export async function previewInsertProof(
  client: Client,
  poolAddress: string,
  opts: PreviewInsertProofOptions,
): Promise<boolean> {
  assertFieldElement("oldRoot", opts.oldRoot);
  assertFieldElement("newRoot", opts.newRoot);
  assertFieldElement("commitment", opts.commitment);
  if (!Number.isInteger(opts.leafIndex) || opts.leafIndex < 0 || opts.leafIndex > 0xffffffff) {
    throw new RangeError("leafIndex must be a uint32");
  }
  const result = await client.runMethod(poolAddress, "previewInsertProof", [
    opts.oldRoot.toString(),
    opts.newRoot.toString(),
    opts.commitment.toString(),
    opts.leafIndex.toString(),
    ...proofPointArgs(opts.proofCell),
  ]);
  assertRunMethodSuccess(result, "previewInsertProof");
  return readBoolean(result.stack[0] ?? null);
}

export interface PreviewWithdrawProofOptions {
  root: bigint;
  nullifierHash: bigint;
  recipientField: bigint;
  proofCell: Cell;
}

export async function previewWithdrawProof(
  client: Client,
  poolAddress: string,
  opts: PreviewWithdrawProofOptions,
): Promise<boolean> {
  assertFieldElement("root", opts.root);
  assertFieldElement("nullifierHash", opts.nullifierHash);
  assertFieldElement("recipientField", opts.recipientField);
  const result = await client.runMethod(poolAddress, "previewWithdrawProof", [
    opts.root.toString(),
    opts.nullifierHash.toString(),
    opts.recipientField.toString(),
    ...proofPointArgs(opts.proofCell),
  ]);
  assertRunMethodSuccess(result, "previewWithdrawProof");
  return readBoolean(result.stack[0] ?? null);
}

export async function readSyncTarget(
  client: Client,
  poolAddress: string,
): Promise<MerkleStateSyncTarget> {
  const state = await readState(client, poolAddress);
  return syncTargetFromState(poolAddress, state);
}

export function syncTargetFromState(
  poolAddress: string,
  state: JettonPoolState,
): MerkleStateSyncTarget {
  return {
    poolAddress,
    nextIndex: state.nextIndex,
    withdrawalCount: state.withdrawalCount,
    currentRoot: state.currentRoot,
  };
}

export function createStateChainReader(client: Client): MerkleStateChainReader {
  return {
    async getMerkleHead(poolAddress) {
      const target = await readSyncTarget(client, poolAddress);
      return {
        nextIndex: target.nextIndex,
        withdrawalCount: target.withdrawalCount,
        currentRoot: target.currentRoot,
      };
    },
    getSparseRoot(poolAddress, setId, bucketId) {
      return readSparseRoot(client, poolAddress, setId, bucketId);
    },
  };
}

/**
 * @deprecated Single-page compatibility helper for explicitly complete, small
 * histories. Production flows require a verified MerkleStateProvider.
 */
export async function fetchDepositCommitmentsLegacy(
  client: Client,
  poolAddress: string,
  limit = 256,
): Promise<DepositEvent[]> {
  const res = await client.getTransactions(poolAddress, limit, undefined);
  if (res.incomplete !== false) {
    throw new Error(
      "legacy deposit scan cannot prove history completeness; use MerkleStateProvider",
    );
  }
  const events: DepositEvent[] = [];
  for (const tx of res.transactions ?? []) {
    if (tx.success !== true) continue;
    for (const out of tx.out_msgs ?? []) {
      if (out.isExternal !== true || !out.body) continue;
      try {
        const event = parseDepositEventCell(Cell.fromBase64(out.body));
        if (event !== null) events.push(event);
      } catch {
        // skip malformed bodies
      }
    }
  }
  return events.sort((a, b) => a.leafIndex - b.leafIndex);
}
