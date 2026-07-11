import { Address } from "@ton/core";
import { describe, expect, it, vi } from "vitest";
import type { Poseidon2 } from "../src/crypto/poseidon.js";
import { buildTree, insertWitnessFromPath } from "../src/merkle.js";
import {
  LocalMerkleStateProvider,
  parseLocalMerkleStateSnapshot,
  serializeLocalMerkleStateSnapshot,
  type IndexedPoolEvent,
  type LocalMerkleStateSnapshot,
  type MerkleStateEventSource,
  type PersistedMerkleStateBatch,
} from "../src/local-state-provider.js";
import {
  COMMITMENT_DOMAIN,
  NULLIFIER_DOMAIN,
  SPARSE_SET_BUCKET_COUNT,
  SPARSE_SET_DEPTH,
  buildSparseSetCrossVector,
  deriveSparseSetCoordinates,
  hashSparseSetNode,
  verifySparseSetUpdate,
} from "../src/sparse-set.js";
import {
  retryOnStaleSparseSetRoot,
  type MerkleStateChainReader,
  type MerkleStateProvider,
  type MerkleStateSyncTarget,
  type SparseSetId,
} from "../src/state-provider.js";

const FIELD = 1n << 248n;
const poseidon2: Poseidon2 = async (a, b) =>
  ((a * 0x12345n + b * 0x6789an + 0xdeadbeefn) ^ ((a << 7n) | (b >> 3n))) % FIELD;
const USER = Address.parseRaw(`0:${"11".repeat(32)}`).toString();

class ReferenceSparseSet {
  readonly roots = new Array<bigint>(SPARSE_SET_BUCKET_COUNT).fill(0n);
  private readonly buckets = new Map<number, Map<bigint, bigint>[]>();

  constructor(private readonly domain: number) {}

  insert(key: bigint) {
    const { bucketId, path } = deriveSparseSetCoordinates(key);
    let levels = this.buckets.get(bucketId);
    if (levels === undefined) {
      levels = Array.from(
        { length: SPARSE_SET_DEPTH + 1 },
        () => new Map<bigint, bigint>(),
      );
      this.buckets.set(bucketId, levels);
    }
    const siblingsByLevel = new Array<bigint>(SPARSE_SET_DEPTH).fill(0n);
    for (let level = 0; level < SPARSE_SET_DEPTH; level += 1) {
      siblingsByLevel[level] = levels[level]?.get(
        (path >> BigInt(level)) ^ 1n,
      ) ?? 0n;
    }
    const vector = buildSparseSetCrossVector({
      domain: this.domain,
      key,
      siblingsByLevel,
    });
    expect(vector.oldRoot).toBe(this.roots[bucketId]);

    let index = path;
    let node = vector.leafHash;
    levels[0]?.set(index, node);
    for (let level = 0; level < SPARSE_SET_DEPTH; level += 1) {
      const sibling = siblingsByLevel[level] as bigint;
      node = (index & 1n) === 0n
        ? hashSparseSetNode(this.domain, level, node, sibling)
        : hashSparseSetNode(this.domain, level, sibling, node);
      index >>= 1n;
      levels[level + 1]?.set(index, node);
    }
    this.roots[bucketId] = node;
    return { bucketId, newRoot: node };
  }
}

async function fixture() {
  const commitments = [1n, 257n, 4n];
  const nullifiers = [2n, 258n];
  const commitmentSet = new ReferenceSparseSet(COMMITMENT_DOMAIN);
  const nullifierSet = new ReferenceSparseSet(NULLIFIER_DOMAIN);
  const events: IndexedPoolEvent[] = [];

  for (const [leafIndex, commitment] of commitments.entries()) {
    const tree = await buildTree(poseidon2, commitments.slice(0, leafIndex + 1));
    events.push({
      position: {
        blockSeqno: 10 + leafIndex,
        transactionLt: BigInt(100 + leafIndex),
        eventIndex: 0,
      },
      event: {
        kind: "deposit",
        leafIndex,
        commitment,
        newRoot: tree.root,
        fromUser: USER,
        sparseUpdate: commitmentSet.insert(commitment),
      },
    });
  }
  for (const [index, nullifierHash] of nullifiers.entries()) {
    events.push({
      position: {
        blockSeqno: 20 + index,
        transactionLt: BigInt(200 + index),
        eventIndex: 0,
      },
      event: {
        kind: "ton-withdraw",
        nullifierHash,
        recipient: USER,
        payout: 10n,
        sparseUpdate: nullifierSet.insert(nullifierHash),
      },
    });
  }

  const finalTree = await buildTree(poseidon2, commitments);
  const target: MerkleStateSyncTarget = {
    poolAddress: "EQ-test",
    nextIndex: commitments.length,
    withdrawalCount: nullifiers.length,
    currentRoot: finalTree.root,
  };
  const chain: MerkleStateChainReader = {
    async getMerkleHead() {
      return {
        nextIndex: target.nextIndex,
        withdrawalCount: target.withdrawalCount,
        currentRoot: target.currentRoot,
      };
    },
    async getSparseRoot(_pool, setId, bucketId) {
      return setId === "commitment"
        ? (commitmentSet.roots[bucketId] as bigint)
        : (nullifierSet.roots[bucketId] as bigint);
    },
  };
  return { commitments, events, target, chain, commitmentSet, nullifierSet };
}

describe("LocalMerkleStateProvider", () => {
  it("rejects recovery-bearing local snapshot version 2 explicitly", () => {
    expect(() => parseLocalMerkleStateSnapshot(JSON.stringify({ schemaVersion: 2 })))
      .toThrow(/removed recovery state/);
  });

  it("sorts newest-first events and exposes only getter-verified paths", async () => {
    const data = await fixture();
    const source: MerkleStateEventSource = {
      async eventsAfter() {
        return {
          events: [...data.events].reverse(),
          scannedThrough: data.events.at(-1)!.position,
        };
      },
    };
    const save = vi.fn(async () => {});
    const appendVerifiedBatch = vi.fn(async () => {});
    const provider = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source,
      chain: data.chain,
      store: {
        async load() { return null; },
        save,
        appendVerifiedBatch,
      },
    });
    await expect(provider.insertionPath(0)).rejects.toThrow(/verified on-chain/);
    const checkpoint = await provider.sync(data.target);
    expect(save).not.toHaveBeenCalled();
    expect(appendVerifiedBatch).toHaveBeenCalledTimes(1);
    expect(checkpoint.nextIndex).toBe(3);
    expect(checkpoint.commitmentSeenRoots).toEqual(data.commitmentSet.roots);
    expect(checkpoint.nullifierSpentRoots).toEqual(data.nullifierSet.roots);

    const path = await provider.insertionPath(3);
    const witness = await insertWitnessFromPath(poseidon2, {
      currentRoot: path.currentRoot,
      commitment: 999n,
      leafIndex: 3,
      path: path.path,
    });
    expect(BigInt(witness.oldRoot)).toBe(data.target.currentRoot);

    const sparse = await provider.sparseSetWitness("commitment", 513n);
    expect(verifySparseSetUpdate({
      domain: sparse.domain,
      key: sparse.key,
      storedRoot: sparse.storedRoot,
      proof: sparse.proof,
    }).oldRoot).toBe(sparse.storedRoot);

  });

  it("rejects getter drift and keeps paths unavailable", async () => {
    const data = await fixture();
    const badChain: MerkleStateChainReader = {
      ...data.chain,
      async getSparseRoot(pool, setId, bucketId) {
        const root = await data.chain.getSparseRoot(pool, setId, bucketId);
        return setId === "commitment" && bucketId === 1 ? root ^ 1n : root;
      },
    };
    const provider = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source: { async eventsAfter() { return {
        events: data.events,
        scannedThrough: data.events.at(-1)!.position,
      }; } },
      chain: badChain,
    });
    await expect(provider.sync(data.target)).rejects.toThrow(/commitmentRoots\[1\]/);
    await expect(provider.membershipPath(0)).rejects.toThrow(/verified on-chain/);
  });

  it("derives the withdrawal count from Jetton events without an event ordinal", async () => {
    const data = await fixture();
    let clientQueryId = 1n;
    const events = data.events.map((indexed) => {
      if (indexed.event.kind !== "ton-withdraw") return indexed;
      const event = {
        ...indexed.event,
        kind: "jetton-withdraw" as const,
        clientQueryId,
      };
      clientQueryId += 1n;
      return { ...indexed, event };
    });
    const provider = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source: { async eventsAfter() { return {
        events,
        scannedThrough: events.at(-1)!.position,
      }; } },
      chain: data.chain,
    });
    await expect(provider.sync(data.target)).resolves.toMatchObject({
      withdrawalCount: data.target.withdrawalCount,
    });
  });

  it("rolls back an unverified replay so a corrected source can recover", async () => {
    const data = await fixture();
    const positions: { transactionLt: bigint; eventIndex: number }[] = [];
    let call = 0;
    const provider = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source: {
        async eventsAfter(_pool, position) {
          positions.push({
            transactionLt: position.transactionLt,
            eventIndex: position.eventIndex,
          });
          call += 1;
          return {
            events: call === 1
              ? data.events.filter(({ position: eventPosition }) =>
                  eventPosition.transactionLt !== 200n)
              : data.events,
            scannedThrough: data.events.at(-1)!.position,
          };
        },
      },
      chain: data.chain,
    });
    await expect(provider.sync(data.target)).rejects.toThrow();
    await expect(provider.checkpoint()).rejects.toThrow(/verified on-chain/);
    await expect(provider.sync(data.target)).resolves.toMatchObject({
      nextIndex: data.target.nextIndex,
      withdrawalCount: data.target.withdrawalCount,
    });
    expect(positions).toEqual([
      { transactionLt: 0n, eventIndex: 0 },
      { transactionLt: 0n, eventIndex: 0 },
    ]);
  });

  it("retries an ambiguously committed journal append idempotently before scanning", async () => {
    const data = await fixture();
    const positions: bigint[] = [];
    const committedPositions = new Set<string>();
    let appendAttempts = 0;
    const provider = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source: {
        async eventsAfter(_pool, position) {
          positions.push(position.transactionLt);
          return position.transactionLt === 0n
            ? {
                events: data.events,
                scannedThrough: data.events.at(-1)!.position,
              }
            : { events: [], scannedThrough: position };
        },
      },
      chain: data.chain,
      store: {
        async load() { return null; },
        async appendVerifiedBatch(_pool, _batch, checkpoint) {
          const key = `${checkpoint.position.transactionLt}:${checkpoint.position.eventIndex}`;
          committedPositions.add(key);
          appendAttempts += 1;
          if (appendAttempts === 1) throw new Error("ambiguous durable write");
        },
      },
    });
    await expect(provider.sync(data.target)).rejects.toThrow(/ambiguous durable write/);
    await expect(provider.checkpoint()).rejects.toThrow(/verified on-chain/);
    await expect(provider.sync(data.target)).resolves.toMatchObject({
      nextIndex: data.target.nextIndex,
      withdrawalCount: data.target.withdrawalCount,
    });
    expect(appendAttempts).toBe(2);
    expect(committedPositions.size).toBe(1);
    expect(positions).toEqual([0n, data.events.at(-1)!.position.transactionLt]);
  });

  it("restores a base snapshot plus its verified journal before RPC replay", async () => {
    const data = await fixture();
    const emptyTree = await buildTree(poseidon2, []);
    const emptyTarget: MerkleStateSyncTarget = {
      poolAddress: data.target.poolAddress,
      nextIndex: 0,
      withdrawalCount: 0,
      currentRoot: emptyTree.root,
    };
    let fullHead = false;
    const chain: MerkleStateChainReader = {
      async getMerkleHead() {
        const target = fullHead ? data.target : emptyTarget;
        return {
          nextIndex: target.nextIndex,
          withdrawalCount: target.withdrawalCount,
          currentRoot: target.currentRoot,
        };
      },
      async getSparseRoot(_pool, setId, bucketId) {
        if (!fullHead) return 0n;
        return setId === "commitment"
          ? (data.commitmentSet.roots[bucketId] as bigint)
          : (data.nullifierSet.roots[bucketId] as bigint);
      },
    };
    const baseProvider = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source: { async eventsAfter(_pool, position) {
        return { events: [], scannedThrough: position };
      } },
      chain,
    });
    await baseProvider.sync(emptyTarget);
    const baseSnapshot = baseProvider.exportSnapshot();

    fullHead = true;
    const journal: PersistedMerkleStateBatch[] = [];
    const writer = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source: { async eventsAfter() {
        return {
          events: data.events,
          scannedThrough: data.events.at(-1)!.position,
        };
      } },
      chain,
      snapshot: baseSnapshot,
      store: {
        async load() { return baseSnapshot; },
        async appendVerifiedBatch(_pool, batch, checkpoint) {
          journal.push({ batch, checkpoint });
        },
      },
    });
    await writer.sync(data.target);
    expect(journal).toHaveLength(1);

    const rpcPositions: bigint[] = [];
    const restarted = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source: { async eventsAfter(_pool, position) {
        rpcPositions.push(position.transactionLt);
        return { events: [], scannedThrough: position };
      } },
      chain,
      store: {
        async load() { return baseSnapshot; },
        loadVerifiedBatches() { return journal; },
      },
    });
    await expect(restarted.sync(data.target)).resolves.toMatchObject({
      nextIndex: data.target.nextIndex,
      withdrawalCount: data.target.withdrawalCount,
    });
    expect(rpcPositions).toEqual([
      data.events.at(-1)!.position.transactionLt,
    ]);
  });

  it("round-trips a full local snapshot before accepting it again", async () => {
    const data = await fixture();
    const provider = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source: { async eventsAfter() { return {
        events: data.events,
        scannedThrough: data.events.at(-1)!.position,
      }; } },
      chain: data.chain,
    });
    await provider.sync(data.target);
    const snapshot = provider.exportSnapshot();
    expect(parseLocalMerkleStateSnapshot(
      serializeLocalMerkleStateSnapshot(snapshot),
    )).toEqual(snapshot);
    let stored: LocalMerkleStateSnapshot | null = snapshot;
    const restorePoseidon = vi.fn(poseidon2);
    const restored = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2: restorePoseidon,
      source: { async eventsAfter(_pool, position) { return {
        events: [],
        scannedThrough: position,
      }; } },
      chain: data.chain,
      store: {
        async load() { return stored; },
        async save(value) { stored = value; },
      },
    });
    expect(restorePoseidon).toHaveBeenCalledTimes(20);
    await expect(restored.checkpoint()).rejects.toThrow(/verified on-chain/);
    await restored.sync(data.target);
    expect(restored.exportSnapshot()).toEqual(snapshot);
  });

  it("restores the compact chunk stream without replaying Poseidon history", async () => {
    const data = await fixture();
    let compactChunks: Uint8Array[] = [];
    const provider = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source: { async eventsAfter() { return {
        events: data.events,
        scannedThrough: data.events.at(-1)!.position,
      }; } },
      chain: data.chain,
      store: {
        async saveCompact(_pool, chunks) { compactChunks = [...chunks]; },
      },
    });
    await provider.sync(data.target);
    await provider.saveCompactSnapshot(128);
    expect(compactChunks.length).toBeGreaterThan(1);

    const restoredPoseidon = vi.fn(poseidon2);
    const restored = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2: restoredPoseidon,
      source: { async eventsAfter(_pool, position) {
        return { events: [], scannedThrough: position };
      } },
      chain: data.chain,
      store: {
        loadCompact() { return compactChunks; },
      },
    });
    expect(restoredPoseidon).toHaveBeenCalledTimes(20);
    await restored.sync(data.target);
    expect((await restored.membershipPath(2)).currentRoot).toBe(data.target.currentRoot);
    await expect(restored.sparseSetWitness("commitment", 513n))
      .resolves.toMatchObject({ setId: "commitment", key: 513n });
  });

  it("rejects a public snapshot cursor ahead of the scanned chain head", async () => {
    const data = await fixture();
    const provider = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      source: { async eventsAfter() { return {
        events: data.events,
        scannedThrough: data.events.at(-1)!.position,
      }; } },
      chain: data.chain,
    });
    await provider.sync(data.target);
    const snapshot = provider.exportSnapshot();
    const poisoned = {
      ...snapshot,
      checkpoint: {
        ...snapshot.checkpoint,
        position: {
          blockSeqno: 999,
          transactionLt: 999_999n,
          eventIndex: 0,
        },
      },
    };
    const restored = await LocalMerkleStateProvider.create({
      poolAddress: data.target.poolAddress,
      poseidon2,
      snapshot: poisoned,
      source: { async eventsAfter() { return {
        events: [],
        scannedThrough: data.events.at(-1)!.position,
      }; } },
      chain: data.chain,
    });
    await expect(restored.sync(data.target)).rejects.toThrow(/cursor is ahead/);
  });
});

describe("retryOnStaleSparseSetRoot", () => {
  it("refreshes only the sparse witness after exit 133", async () => {
    const sync = vi.fn(async (target: MerkleStateSyncTarget) => ({
      schemaVersion: 1 as const,
      poolAddress: target.poolAddress,
      position: { blockSeqno: 1, transactionLt: 1n, eventIndex: 0 },
      nextIndex: target.nextIndex,
      withdrawalCount: target.withdrawalCount,
      currentRoot: target.currentRoot,
      commitmentSeenRoots: new Array<bigint>(256).fill(0n),
      nullifierSpentRoots: new Array<bigint>(256).fill(0n),
    }));
    let root = 1n;
    const provider = {
      privacyMode: "local",
      sync,
      async checkpoint() { throw new Error("unused"); },
      async insertionPath() { throw new Error("unused"); },
      async membershipPath() { throw new Error("unused"); },
      async sparseSetWitness(setId: SparseSetId, key: bigint) {
        return {
          setId,
          domain: NULLIFIER_DOMAIN,
          key,
          bucketId: 1,
          storedRoot: root++,
          proof: { expectedRoot: root - 1n, siblingBitmap: 0n, siblings: [] },
        };
      },
    } satisfies MerkleStateProvider;
    const operation = vi.fn(async (witness: Awaited<ReturnType<typeof provider.sparseSetWitness>>) => {
      if (witness.storedRoot === 1n) throw { exitCode: 133 };
      return witness.storedRoot;
    });
    await expect(retryOnStaleSparseSetRoot({
      provider,
      setId: "nullifier",
      key: 1n,
      getSyncTarget: async () => ({
        poolAddress: "EQ-test",
        nextIndex: 1,
        withdrawalCount: 0,
        currentRoot: 2n,
      }),
      operation,
    })).resolves.toBe(2n);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
