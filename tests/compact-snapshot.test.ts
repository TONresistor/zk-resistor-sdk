import { describe, expect, it, vi } from "vitest";
import {
  decodeCompactSnapshotChunks,
  encodeCompactSnapshotChunks,
  type CompactMerkleSnapshotSink,
  type CompactMerkleSnapshotSource,
} from "../src/compact-snapshot.js";
import type { MerkleStateCheckpoint } from "../src/state-provider.js";

function checkpoint(): MerkleStateCheckpoint {
  return {
    schemaVersion: 1,
    poolAddress: "EQ-compact-test",
    position: { blockSeqno: 12, transactionLt: 34n, eventIndex: 2 },
    nextIndex: 2,
    withdrawalCount: 1,
    currentRoot: 0x1234n,
    commitmentSeenRoots: new Array<bigint>(256).fill(0n),
    nullifierSpentRoots: new Array<bigint>(256).fill(0n),
  };
}

function source(): CompactMerkleSnapshotSource {
  return {
    checkpoint: checkpoint(),
    poseidonNodeCount: 3,
    poseidonNodes: [
      { level: 0, index: 0, value: 1n },
      { level: 0, index: 1, value: 2n },
      { level: 1, index: 0, value: 3n },
    ],
    commitmentLeafCount: 2,
    commitmentLeaves: [
      { key: 1n, leafHash: 11n },
      { key: 2n, leafHash: 22n },
    ],
    nullifierLeafCount: 1,
    nullifierLeaves: [{ key: 3n, leafHash: 33n }],
  };
}

describe("compact snapshot stream", () => {
  it("round-trips through small chunks directly into a sink", async () => {
    const observed = {
      checkpoint: null as MerkleStateCheckpoint | null,
      poseidon: [] as unknown[],
      sparse: [] as unknown[],
    };
    const sink: CompactMerkleSnapshotSink = {
      begin(value) { observed.checkpoint = value; },
      poseidonNode(value) { observed.poseidon.push(value); },
      sparseLeaf(setId, value) { observed.sparse.push({ setId, ...value }); },
      end: vi.fn(),
    };
    const chunks = [...encodeCompactSnapshotChunks(source(), 67)];
    expect(chunks.length).toBeGreaterThan(2);
    await expect(decodeCompactSnapshotChunks(chunks, sink)).resolves.toEqual(
      checkpoint(),
    );
    expect(observed.checkpoint).toEqual(checkpoint());
    expect(observed.poseidon).toEqual([...source().poseidonNodes]);
    expect(observed.sparse).toEqual([
      { setId: "commitment", key: 1n, leafHash: 11n },
      { setId: "commitment", key: 2n, leafHash: 22n },
      { setId: "nullifier", key: 3n, leafHash: 33n },
    ]);
    expect(sink.end).toHaveBeenCalledTimes(1);
  });

  it("rejects declared record counts that do not match the stream", () => {
    const invalid = { ...source(), poseidonNodeCount: 4 };
    expect(() => [...encodeCompactSnapshotChunks(invalid, 128)])
      .toThrow(/does not match declared/);
  });

  it("rejects trailing bytes", async () => {
    const chunks = [...encodeCompactSnapshotChunks(source(), 128), Uint8Array.of(1)];
    const sink: CompactMerkleSnapshotSink = {
      begin() {},
      poseidonNode() {},
      sparseLeaf() {},
      end() {},
    };
    await expect(decodeCompactSnapshotChunks(chunks, sink))
      .rejects.toThrow(/trailing/);
  });

  it("rejects recovery-bearing format 1 snapshots explicitly", async () => {
    const bytes = Uint8Array.from(
      [...encodeCompactSnapshotChunks(source(), 1 << 20)].flatMap((chunk) => [...chunk]),
    );
    bytes[8] = 0;
    bytes[9] = 1;
    const sink: CompactMerkleSnapshotSink = {
      begin() {},
      poseidonNode() {},
      sparseLeaf() {},
      end() {},
    };
    await expect(decodeCompactSnapshotChunks([bytes], sink))
      .rejects.toThrow(/removed recovery state/);
  });
});
