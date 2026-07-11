import type { Client } from "./client.js";
import { parseTonPoolStorage } from "./storage.js";
import type { TonPoolState } from "./types.js";
import type {
  MerkleStateChainReader,
  MerkleStateSyncTarget,
} from "./state-provider.js";
import { readSparseRoot } from "./pool.js";
import { assertRunMethodSuccess, readBigInt } from "./stack.js";

export {
  fetchDepositCommitmentsLegacy,
} from "./pool.js";
export { readSparseRoot } from "./pool.js";
export {
  readFactory,
  readDenomination,
  readCurrentRoot,
  readNextIndex,
  readRentRunway,
  readRelayerReserve,
  readWithdrawalCount,
  readTreeDepth,
} from "./pool.js";

export async function readPendingWithdrawTon(
  client: Client,
  poolAddress: string,
): Promise<bigint> {
  const result = await client.runMethod(poolAddress, "pendingWithdrawTon", []);
  assertRunMethodSuccess(result, "pendingWithdrawTon");
  return readBigInt(result.stack[0] ?? null);
}

export async function readState(
  client: Client,
  poolAddress: string,
): Promise<TonPoolState> {
  const acc = await client.getAccountState(poolAddress);
  if (acc.status !== "active" || !acc.data) {
    throw new Error(
      `TON pool ${poolAddress} is not active (status: ${acc.status}).`,
    );
  }
  const s = parseTonPoolStorage(acc.data);
  return {
    currentRoot: s.currentRoot,
    nextIndex: s.nextIndex,
    denomination: s.denomination,
    pendingWithdrawTon: s.pendingWithdrawTon,
    relayerReserve: s.relayerReserve,
  };
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
  state: TonPoolState,
): MerkleStateSyncTarget {
  if (
    state.denomination <= 0n ||
    state.pendingWithdrawTon % state.denomination !== 0n
  ) {
    throw new Error("TON pool storage has inconsistent pending liquidity");
  }
  const pendingDeposits = state.pendingWithdrawTon / state.denomination;
  const withdrawalCountBig = BigInt(state.nextIndex) - pendingDeposits;
  if (withdrawalCountBig < 0n || withdrawalCountBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("TON pool storage implies an invalid withdrawal count");
  }
  const withdrawalCount = Number(withdrawalCountBig);
  return {
    poolAddress,
    nextIndex: state.nextIndex,
    withdrawalCount,
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
