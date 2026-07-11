import { describe, expect, it, vi } from "vitest";
import {
  sparseSetDomain,
  SPARSE_ROOT_GETTER_CONCURRENCY,
  validateMerkleStateCheckpoint,
  verifyHeadCheckpoint,
  type MerkleStateChainReader,
  type MerkleStateCheckpoint,
} from "../src/state-provider.js";
import {
  COMMITMENT_DOMAIN,
  NULLIFIER_DOMAIN,
  SPARSE_SET_BUCKET_COUNT,
} from "../src/sparse-set.js";

function checkpoint(): MerkleStateCheckpoint {
  return {
    schemaVersion: 1,
    poolAddress: "EQ-test-pool",
    position: { blockSeqno: 12, transactionLt: 34n, eventIndex: 0 },
    nextIndex: 5,
    withdrawalCount: 2,
    currentRoot: 6n,
    commitmentSeenRoots: Array.from(
      { length: SPARSE_SET_BUCKET_COUNT },
      (_, bucketId) => BigInt(bucketId),
    ),
    nullifierSpentRoots: Array.from(
      { length: SPARSE_SET_BUCKET_COUNT },
      (_, bucketId) => BigInt(bucketId + 1000),
    ),
  };
}

describe("MerkleStateProvider checkpoints", () => {
  it("maps sparse set identifiers to their frozen domains", () => {
    expect(sparseSetDomain("commitment")).toBe(COMMITMENT_DOMAIN);
    expect(sparseSetDomain("nullifier")).toBe(NULLIFIER_DOMAIN);
  });

  it("validates the complete 256-bucket snapshot shape", () => {
    const valid = checkpoint();
    expect(() => validateMerkleStateCheckpoint(valid)).not.toThrow();
    expect(() =>
      validateMerkleStateCheckpoint({
        ...valid,
        commitmentSeenRoots: valid.commitmentSeenRoots.slice(1),
      }),
    ).toThrow(RangeError);
  });

  it("verifies every root and head counter against chain getters", async () => {
    const local = checkpoint();
    let activeSparseReads = 0;
    let maxSparseReads = 0;
    const getSparseRoot = vi.fn(
      async (_pool: string, setId: "commitment" | "nullifier", bucket: number) => {
        activeSparseReads += 1;
        maxSparseReads = Math.max(maxSparseReads, activeSparseReads);
        await Promise.resolve();
        const root = setId === "commitment"
          ? (local.commitmentSeenRoots[bucket] as bigint)
          : (local.nullifierSpentRoots[bucket] as bigint);
        activeSparseReads -= 1;
        return root;
      },
    );
    const reader: MerkleStateChainReader = {
      async getMerkleHead() {
        return {
          nextIndex: local.nextIndex,
          withdrawalCount: local.withdrawalCount,
          currentRoot: local.currentRoot,
        };
      },
      getSparseRoot,
    };

    await expect(verifyHeadCheckpoint(local, reader)).resolves.toEqual({
      valid: true,
      mismatches: [],
    });
    expect(getSparseRoot).toHaveBeenCalledTimes(512);
    expect(maxSparseReads).toBeLessThanOrEqual(SPARSE_ROOT_GETTER_CONCURRENCY);

    const changedReader: MerkleStateChainReader = {
      ...reader,
      async getMerkleHead() {
        return {
          nextIndex: local.nextIndex + 1,
          withdrawalCount: local.withdrawalCount,
          currentRoot: local.currentRoot,
        };
      },
      async getSparseRoot(pool, setId, bucket) {
        const root = await getSparseRoot(pool, setId, bucket);
        return setId === "nullifier" && bucket === 19 ? root + 1n : root;
      },
    };
    const verification = await verifyHeadCheckpoint(local, changedReader);
    expect(verification.valid).toBe(false);
    expect(verification.mismatches.map((m) => m.field)).toEqual([
      "nextIndex",
      "nullifierRoots[19]",
    ]);
  });
});
