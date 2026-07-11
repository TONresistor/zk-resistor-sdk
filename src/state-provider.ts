import {
  COMMITMENT_DOMAIN,
  NULLIFIER_DOMAIN,
  SPARSE_SET_BUCKET_COUNT,
} from "./sparse-set.js";
import type { SparseSetUpdateProof } from "./sparse-set.js";
import type { MerklePath } from "./types.js";
import { Errors } from "./errors.js";

export type SparseSetId = "commitment" | "nullifier";
export type MerkleStatePrivacyMode =
  | "local"
  | "full-snapshot"
  | "split-remote";

export interface ReplayPosition {
  blockSeqno: number;
  transactionLt: bigint;
  eventIndex: number;
}

export interface MerkleStateCheckpoint {
  schemaVersion: 1;
  poolAddress: string;
  position: ReplayPosition;
  nextIndex: number;
  withdrawalCount: number;
  currentRoot: bigint;
  /** Exactly 256 roots, indexed by the key's low byte. */
  commitmentSeenRoots: readonly bigint[];
  /** Exactly 256 roots, indexed by the key's low byte. */
  nullifierSpentRoots: readonly bigint[];
}

export interface PoseidonInsertPath {
  nextIndex: number;
  currentRoot: bigint;
  path: MerklePath;
}

export interface PoseidonMembershipPath {
  leafIndex: number;
  currentRoot: bigint;
  path: MerklePath;
}

export interface SparseSetWitness {
  setId: SparseSetId;
  domain: number;
  key: bigint;
  bucketId: number;
  storedRoot: bigint;
  proof: SparseSetUpdateProof;
}

export interface MerkleStateSyncTarget {
  poolAddress: string;
  nextIndex: number;
  withdrawalCount: number;
  currentRoot: bigint;
}

/**
 * Incremental state backend used by deposit and withdrawal flows.
 *
 * Implementations must verify remote snapshots against the chain before use.
 * A remote provider should expose either a complete snapshot or separate
 * commitment/nullifier endpoints so one request cannot trivially correlate a note.
 */
export interface MerkleStateProvider {
  readonly privacyMode: MerkleStatePrivacyMode;

  sync(target: MerkleStateSyncTarget): Promise<MerkleStateCheckpoint>;
  checkpoint(): Promise<MerkleStateCheckpoint>;

  insertionPath(nextIndex: number): Promise<PoseidonInsertPath>;
  membershipPath(leafIndex: number): Promise<PoseidonMembershipPath>;

  sparseSetWitness(setId: SparseSetId, key: bigint): Promise<SparseSetWitness>;
}

export interface MerkleStateChainReader {
  getMerkleHead(poolAddress: string): Promise<{
    nextIndex: number;
    withdrawalCount: number;
    currentRoot: bigint;
  }>;
  getSparseRoot(
    poolAddress: string,
    setId: SparseSetId,
    bucketId: number,
  ): Promise<bigint>;
}

export interface CheckpointMismatch {
  field: string;
  expected: bigint | number;
  actual: bigint | number;
}

export interface CheckpointVerification {
  valid: boolean;
  mismatches: readonly CheckpointMismatch[];
}

const UINT256_LIMIT = 1n << 256n;
export const SPARSE_ROOT_GETTER_CONCURRENCY = 16;

function assertRoot(name: string, root: bigint): void {
  if (root < 0n || root >= UINT256_LIMIT) {
    throw new RangeError(`${name} must be a uint256`);
  }
}

function validateRootTable(name: string, roots: readonly bigint[]): void {
  if (roots.length !== SPARSE_SET_BUCKET_COUNT) {
    throw new RangeError(
      `${name} must contain exactly ${SPARSE_SET_BUCKET_COUNT} roots`,
    );
  }
  for (const [bucketId, root] of roots.entries()) {
    assertRoot(`${name}[${bucketId}]`, root);
  }
}

export function sparseSetDomain(setId: SparseSetId): number {
  return setId === "commitment" ? COMMITMENT_DOMAIN : NULLIFIER_DOMAIN;
}

export function validateMerkleStateCheckpoint(
  checkpoint: MerkleStateCheckpoint,
): void {
  if (checkpoint.schemaVersion !== 1) {
    throw new RangeError("unsupported Merkle state checkpoint version");
  }
  if (checkpoint.poolAddress.length === 0) {
    throw new RangeError("checkpoint poolAddress cannot be empty");
  }
  if (!Number.isSafeInteger(checkpoint.nextIndex) || checkpoint.nextIndex < 0) {
    throw new RangeError("checkpoint nextIndex must be a non-negative integer");
  }
  if (
    !Number.isSafeInteger(checkpoint.withdrawalCount) ||
    checkpoint.withdrawalCount < 0 ||
    checkpoint.withdrawalCount > checkpoint.nextIndex
  ) {
    throw new RangeError("checkpoint withdrawalCount is invalid");
  }
  if (
    !Number.isSafeInteger(checkpoint.position.blockSeqno) ||
    checkpoint.position.blockSeqno < 0 ||
    checkpoint.position.transactionLt < 0n ||
    !Number.isSafeInteger(checkpoint.position.eventIndex) ||
    checkpoint.position.eventIndex < 0
  ) {
    throw new RangeError("checkpoint replay position is invalid");
  }
  assertRoot("checkpoint currentRoot", checkpoint.currentRoot);
  validateRootTable(
    "checkpoint commitmentSeenRoots",
    checkpoint.commitmentSeenRoots,
  );
  validateRootTable(
    "checkpoint nullifierSpentRoots",
    checkpoint.nullifierSpentRoots,
  );
}

/** Verify a head checkpoint against getters before trusting its local paths. */
export async function verifyHeadCheckpoint(
  checkpoint: MerkleStateCheckpoint,
  chain: MerkleStateChainReader,
): Promise<CheckpointVerification> {
  validateMerkleStateCheckpoint(checkpoint);
  const mismatches: CheckpointMismatch[] = [];
  const head = await chain.getMerkleHead(checkpoint.poolAddress);

  if (head.nextIndex !== checkpoint.nextIndex) {
    mismatches.push({
      field: "nextIndex",
      expected: head.nextIndex,
      actual: checkpoint.nextIndex,
    });
  }
  if (head.currentRoot !== checkpoint.currentRoot) {
    mismatches.push({
      field: "currentRoot",
      expected: head.currentRoot,
      actual: checkpoint.currentRoot,
    });
  }
  if (head.withdrawalCount !== checkpoint.withdrawalCount) {
    mismatches.push({
      field: "withdrawalCount",
      expected: head.withdrawalCount,
      actual: checkpoint.withdrawalCount,
    });
  }


  const tables: readonly [SparseSetId, readonly bigint[]][] = [
    ["commitment", checkpoint.commitmentSeenRoots],
    ["nullifier", checkpoint.nullifierSpentRoots],
  ];
  for (const [setId, roots] of tables) {
    for (
      let offset = 0;
      offset < SPARSE_SET_BUCKET_COUNT;
      offset += SPARSE_ROOT_GETTER_CONCURRENCY
    ) {
      const count = Math.min(
        SPARSE_ROOT_GETTER_CONCURRENCY,
        SPARSE_SET_BUCKET_COUNT - offset,
      );
      const onChainRoots = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          chain.getSparseRoot(
            checkpoint.poolAddress,
            setId,
            offset + index,
          )),
      );
      for (const [index, expected] of onChainRoots.entries()) {
        const bucketId = offset + index;
        const actual = roots[bucketId] as bigint;
        assertRoot(`${setId} getter root ${bucketId}`, expected);
        if (expected !== actual) {
          mismatches.push({
            field: `${setId}Roots[${bucketId}]`,
            expected,
            actual,
          });
        }
      }
    }
  }

  return { valid: mismatches.length === 0, mismatches };
}

export function contractExitCode(error: unknown): number | undefined {
  if (typeof error === "number") return error;
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const field of ["exitCode", "exit_code", "code"] as const) {
    const value = record[field];
    if (typeof value === "number") return value;
    if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
  }
  return undefined;
}

export function isStaleSparseSetRootError(error: unknown): boolean {
  return contractExitCode(error) === Errors.StaleSparseSetRoot;
}

export interface SparseSetRetryOptions<T> {
  provider: MerkleStateProvider;
  setId: SparseSetId;
  key: bigint;
  getSyncTarget: () => Promise<MerkleStateSyncTarget>;
  operation: (witness: SparseSetWitness, attempt: number) => Promise<T>;
  maxRetries?: number;
}

/**
 * Refresh only the transparent sparse witness after contract exit 133. The
 * caller keeps its already-generated Groth16 proof and rebuilds the message in
 * `operation`, so a same-root nullifier race does not trigger proving again.
 */
export async function retryOnStaleSparseSetRoot<T>(
  options: SparseSetRetryOptions<T>,
): Promise<T> {
  const maxRetries = options.maxRetries ?? 1;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError("maxRetries must be a non-negative integer");
  }
  for (let attempt = 0; ; attempt += 1) {
    await options.provider.sync(await options.getSyncTarget());
    const witness = await options.provider.sparseSetWitness(
      options.setId,
      options.key,
    );
    try {
      return await options.operation(witness, attempt);
    } catch (error) {
      if (attempt >= maxRetries || !isStaleSparseSetRootError(error)) throw error;
    }
  }
}
