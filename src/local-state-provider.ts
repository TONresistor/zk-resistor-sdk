import { TREE_CAPACITY, TREE_DEPTH } from "./constants.js";
import {
  decodeCompactSnapshotChunks,
  encodeCompactSnapshotChunks,
  type CompactMerkleSnapshotSink,
  type CompactMerkleSnapshotSource,
  type CompactPoseidonNode,
  type CompactSparseLeaf,
  type CompactSnapshotChunks,
} from "./compact-snapshot.js";
import type { Poseidon2 } from "./crypto/poseidon.js";
import { emptyZeros } from "./crypto/poseidon.js";
import type { ParsedPoolEvent } from "./events.js";
import {
  SPARSE_SET_BUCKET_COUNT,
  SPARSE_SET_DEPTH,
  compressSparseSetSiblings,
  deriveSparseSetCoordinates,
  hashSparseSetLeaf,
  hashSparseSetNode,
  verifySparseSetUpdate,
} from "./sparse-set.js";
import type {
  MerkleStateChainReader,
  MerkleStateCheckpoint,
  MerkleStateProvider,
  MerkleStateSyncTarget,
  PoseidonInsertPath,
  PoseidonMembershipPath,
  ReplayPosition,
  SparseSetId,
  SparseSetWitness,
} from "./state-provider.js";
import {
  sparseSetDomain,
  validateMerkleStateCheckpoint,
  verifyHeadCheckpoint,
} from "./state-provider.js";

export interface IndexedPoolEvent {
  position: ReplayPosition;
  event: ParsedPoolEvent;
}

export interface MerkleStateEventBatch {
  events: readonly IndexedPoolEvent[];
  /** Highest transaction cursor scanned, including transactions with no event. */
  scannedThrough: ReplayPosition;
}

export interface MerkleStateEventSource {
  eventsAfter(
    poolAddress: string,
    position: ReplayPosition,
  ): Promise<MerkleStateEventBatch>;
}

export interface LocalMerkleStateSnapshot {
  schemaVersion: 3;
  checkpoint: MerkleStateCheckpoint;
  poseidonLayers: readonly (readonly [number, bigint])[][];
  commitmentIndex: SerializedSparseSetIndex;
  nullifierIndex: SerializedSparseSetIndex;
}

export interface MerkleStateSnapshotStore {
  load?(poolAddress: string): Promise<LocalMerkleStateSnapshot | null>;
  /** Compact base snapshot for bounded-memory restore. */
  loadCompact?(
    poolAddress: string,
  ): CompactSnapshotChunks | null | Promise<CompactSnapshotChunks | null>;
  /** Explicit full compaction; never called by sync(). */
  save?(snapshot: LocalMerkleStateSnapshot): Promise<void>;
  /** Atomic replacement hook for the compact, bounded-memory snapshot stream. */
  saveCompact?(
    poolAddress: string,
    chunks: Iterable<Uint8Array>,
  ): Promise<void>;
  /**
   * Optional O(delta) journal hook called after a verified replay batch.
   * The implementation MUST atomically and idempotently commit by the supplied
   * checkpoint position; a retry after an ambiguous throw must not duplicate it.
   */
  appendVerifiedBatch?(
    poolAddress: string,
    batch: MerkleStateEventBatch,
    checkpoint: MerkleStateCheckpoint,
  ): Promise<void>;
  /**
   * Replays the durable journal after the loaded base snapshot. Entries must
   * be returned in strictly increasing checkpoint-position order.
   */
  loadVerifiedBatches?(
    poolAddress: string,
    after: ReplayPosition,
  ):
    | Iterable<PersistedMerkleStateBatch>
    | AsyncIterable<PersistedMerkleStateBatch>
    | Promise<
        | Iterable<PersistedMerkleStateBatch>
        | AsyncIterable<PersistedMerkleStateBatch>
      >;
}

export interface PersistedMerkleStateBatch {
  batch: MerkleStateEventBatch;
  checkpoint: MerkleStateCheckpoint;
}

export interface LocalMerkleStateProviderOptions {
  poolAddress: string;
  poseidon2: Poseidon2;
  source: MerkleStateEventSource;
  chain: MerkleStateChainReader;
  store?: MerkleStateSnapshotStore;
  snapshot?: LocalMerkleStateSnapshot;
}

const SNAPSHOT_BIGINT_PREFIX = "#bigint:";

export interface SerializedSparseLeaf {
  kind: "leaf";
  key: bigint;
  path: bigint;
  leafHash: bigint;
  hashes: readonly (readonly [number, bigint])[];
}

export interface SerializedSparseBranch {
  kind: "branch";
  level: number;
  path: bigint;
  left: SerializedSparseNode;
  right: SerializedSparseNode;
  hashes: readonly (readonly [number, bigint])[];
}

export type SerializedSparseNode = SerializedSparseLeaf | SerializedSparseBranch;

export interface SerializedSparseSetIndex {
  roots: readonly bigint[];
  keys: readonly bigint[];
  buckets: readonly (readonly [number, SerializedSparseNode])[];
}

export function serializeLocalMerkleStateSnapshot(
  snapshot: LocalMerkleStateSnapshot,
): string {
  validateLocalSnapshot(snapshot);
  return JSON.stringify(snapshot, (_key, value: unknown) =>
    typeof value === "bigint"
      ? `${SNAPSHOT_BIGINT_PREFIX}${value.toString(16)}`
      : value);
}

export function parseLocalMerkleStateSnapshot(
  serialized: string,
): LocalMerkleStateSnapshot {
  const value = JSON.parse(serialized, (_key, entry: unknown) => {
    if (
      typeof entry === "string" &&
      entry.startsWith(SNAPSHOT_BIGINT_PREFIX)
    ) {
      const hex = entry.slice(SNAPSHOT_BIGINT_PREFIX.length);
      if (!/^[0-9a-f]+$/i.test(hex)) throw new Error("invalid snapshot bigint");
      return BigInt(`0x${hex}`);
    }
    return entry;
  }) as LocalMerkleStateSnapshot;
  validateLocalSnapshot(value);
  return value;
}

function validateLocalSnapshot(snapshot: LocalMerkleStateSnapshot): void {
  if (
    snapshot !== null &&
    typeof snapshot === "object" &&
    (snapshot as { schemaVersion?: unknown }).schemaVersion === 2
  ) {
    throw new Error(
      "local snapshot version 2 contains removed recovery state; rebuild it from chain",
    );
  }
  if (snapshot === null || typeof snapshot !== "object" || snapshot.schemaVersion !== 3) {
    throw new Error("unsupported local snapshot version");
  }
  validateMerkleStateCheckpoint(snapshot.checkpoint);
  if (
    !Array.isArray(snapshot.poseidonLayers) ||
    snapshot.poseidonLayers.length !== TREE_DEPTH + 1 ||
    !Array.isArray(snapshot.commitmentIndex?.roots) ||
    !Array.isArray(snapshot.nullifierIndex?.roots)
  ) {
    throw new Error("local snapshot collections are malformed");
  }
  for (const layer of snapshot.poseidonLayers) {
    for (const [index, node] of layer) {
      if (!Number.isSafeInteger(index) || index < 0 || typeof node !== "bigint") {
        throw new Error("local snapshot Poseidon layer is malformed");
      }
    }
  }
}

type SparseNode = SparseLeaf | SparseBranch;

interface SparseLeaf {
  kind: "leaf";
  key: bigint;
  path: bigint;
  leafHash: bigint;
  hashes: Map<number, bigint>;
}

interface SparseBranch {
  kind: "branch";
  level: number;
  path: bigint;
  left: SparseNode;
  right: SparseNode;
  hashes: Map<number, bigint>;
}

function serializeSparseNode(node: SparseNode): SerializedSparseNode {
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      key: node.key,
      path: node.path,
      leafHash: node.leafHash,
      hashes: [...node.hashes],
    };
  }
  return {
    kind: "branch",
    level: node.level,
    path: node.path,
    left: serializeSparseNode(node.left),
    right: serializeSparseNode(node.right),
    hashes: [...node.hashes],
  };
}

function deserializeSparseNode(node: SerializedSparseNode): SparseNode {
  const hashes = new Map<number, bigint>(
    node.hashes.map(([height, hash]) => [height, hash]),
  );
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      key: node.key,
      path: node.path,
      leafHash: node.leafHash,
      hashes,
    };
  }
  return {
    kind: "branch",
    level: node.level,
    path: node.path,
    left: deserializeSparseNode(node.left),
    right: deserializeSparseNode(node.right),
    hashes,
  };
}

function highestDifferentBit(a: bigint, b: bigint): number {
  let difference = a ^ b;
  if (difference === 0n) return -1;
  let bit = -1;
  while (difference !== 0n) {
    difference >>= 1n;
    bit += 1;
  }
  return bit;
}

function nativeHeight(node: SparseNode): number {
  return node.kind === "leaf" ? 0 : node.level + 1;
}

class SparseBucketIndex {
  private rootNode: SparseNode | null = null;

  constructor(private readonly domain: number) {}

  private hashToHeight(node: SparseNode, height: number): bigint {
    const ownHeight = nativeHeight(node);
    if (height < ownHeight || height > SPARSE_SET_DEPTH) {
      throw new RangeError("invalid compressed sparse subtree height");
    }
    const cached = node.hashes.get(height);
    if (cached !== undefined) return cached;

    let hash: bigint;
    let level: number;
    if (node.kind === "leaf") {
      hash = node.leafHash;
      level = 0;
    } else {
      const left = this.hashToHeight(node.left, node.level);
      const right = this.hashToHeight(node.right, node.level);
      hash = hashSparseSetNode(this.domain, node.level, left, right);
      level = node.level + 1;
    }
    for (; level < height; level += 1) {
      hash = ((node.path >> BigInt(level)) & 1n) === 0n
        ? hashSparseSetNode(this.domain, level, hash, 0n)
        : hashSparseSetNode(this.domain, level, 0n, hash);
    }
    node.hashes.set(height, hash);
    return hash;
  }

  root(): bigint {
    return this.rootNode === null
      ? 0n
      : this.hashToHeight(this.rootNode, SPARSE_SET_DEPTH);
  }

  snapshot(): SerializedSparseNode | null {
    return this.rootNode === null ? null : serializeSparseNode(this.rootNode);
  }

  restore(snapshot: SerializedSparseNode): void {
    this.rootNode = deserializeSparseNode(snapshot);
    if (!this.rootNode.hashes.has(SPARSE_SET_DEPTH)) {
      throw new Error("sparse bucket snapshot is missing its root cache");
    }
  }

  checkpointRoot(): SparseNode | null {
    return this.rootNode;
  }

  restoreRoot(rootNode: SparseNode | null): void {
    this.rootNode = rootNode;
  }

  *compactLeaves(node: SparseNode | null = this.rootNode): Generator<CompactSparseLeaf> {
    if (node === null) return;
    if (node.kind === "leaf") {
      yield { key: node.key, leafHash: node.leafHash };
      return;
    }
    yield* this.compactLeaves(node.left);
    yield* this.compactLeaves(node.right);
  }

  private makeLeaf(key: bigint, path: bigint): SparseLeaf {
    return {
      kind: "leaf",
      key,
      path,
      leafHash: hashSparseSetLeaf(this.domain, key),
      hashes: new Map(),
    };
  }

  restoreCompactLeaf(key: bigint, leafHash: bigint): void {
    const { path } = deriveSparseSetCoordinates(key);
    if (leafHash < 0n || leafHash >= (1n << 256n)) {
      throw new RangeError("compact sparse leaf hash must be a uint256");
    }
    const leaf: SparseLeaf = {
      kind: "leaf",
      key,
      path,
      leafHash,
      hashes: new Map(),
    };
    this.rootNode = this.rootNode === null
      ? leaf
      : this.insertNode(this.rootNode, leaf);
  }

  finalizeCompactRoot(expectedRoot: bigint): void {
    if (this.rootNode === null) {
      if (expectedRoot !== 0n) {
        throw new Error("compact sparse bucket is missing for a non-zero root");
      }
      return;
    }
    if (expectedRoot === 0n) {
      throw new Error("compact sparse bucket has leaves under a zero root");
    }
    this.rootNode.hashes.set(SPARSE_SET_DEPTH, expectedRoot);
  }

  private makeBranch(a: SparseNode, b: SparseNode, level: number): SparseBranch {
    const aBit = Number((a.path >> BigInt(level)) & 1n);
    const bBit = Number((b.path >> BigInt(level)) & 1n);
    if (aBit === bBit) throw new Error("invalid compressed sparse branch");
    return {
      kind: "branch",
      level,
      path: a.path,
      left: aBit === 0 ? a : b,
      right: aBit === 0 ? b : a,
      hashes: new Map(),
    };
  }

  private insertNode(node: SparseNode, leaf: SparseLeaf): SparseNode {
    const difference = highestDifferentBit(node.path, leaf.path);
    if (difference < 0) {
      throw new Error("sparse-set key is already present");
    }
    if (node.kind === "leaf" || difference > node.level) {
      return this.makeBranch(node, leaf, difference);
    }

    const bit = Number((leaf.path >> BigInt(node.level)) & 1n);
    return {
      kind: "branch",
      level: node.level,
      path: node.path,
      left: bit === 0 ? this.insertNode(node.left, leaf) : node.left,
      right: bit === 1 ? this.insertNode(node.right, leaf) : node.right,
      hashes: new Map(),
    };
  }

  witness(key: bigint): SparseSetWitness["proof"] {
    const { path } = deriveSparseSetCoordinates(key);
    const siblings = new Array<bigint>(SPARSE_SET_DEPTH).fill(0n);
    let node = this.rootNode;

    while (node !== null && node.kind === "branch") {
      const divergence = highestDifferentBit(node.path, path);
      if (divergence > node.level) {
        siblings[divergence] = this.hashToHeight(node, divergence);
        node = null;
        break;
      }
      const bit = Number((path >> BigInt(node.level)) & 1n);
      const sibling = bit === 0 ? node.right : node.left;
      siblings[node.level] = this.hashToHeight(sibling, node.level);
      node = bit === 0 ? node.left : node.right;
    }
    if (node !== null) {
      if (node.path === path) {
        throw new Error("sparse-set key is already present");
      }
      const divergence = highestDifferentBit(node.path, path);
      siblings[divergence] = this.hashToHeight(node, divergence);
    }

    return {
      expectedRoot: this.root(),
      ...compressSparseSetSiblings(siblings),
    };
  }

  commit(key: bigint, path: bigint, expectedNewRoot: bigint): void {
    const leaf = this.makeLeaf(key, path);
    this.rootNode = this.rootNode === null
      ? leaf
      : this.insertNode(this.rootNode, leaf);
    this.rootNode.hashes.set(SPARSE_SET_DEPTH, expectedNewRoot);
  }
}

class SparseSetIndex {
  readonly roots = new Array<bigint>(SPARSE_SET_BUCKET_COUNT).fill(0n);
  readonly keys = new Set<bigint>();
  private readonly buckets = new Map<number, SparseBucketIndex>();

  constructor(readonly setId: SparseSetId) {}

  witness(key: bigint): SparseSetWitness {
    if (this.keys.has(key)) throw new Error(`${this.setId} key is already present`);
    const { bucketId } = deriveSparseSetCoordinates(key);
    const bucket = this.buckets.get(bucketId) ??
      new SparseBucketIndex(sparseSetDomain(this.setId));
    const proof = bucket.witness(key);
    return {
      setId: this.setId,
      domain: sparseSetDomain(this.setId),
      key,
      bucketId,
      storedRoot: this.roots[bucketId] as bigint,
      proof,
    };
  }

  preview(key: bigint, expectedBucket: number, expectedRoot: bigint): void {
    const witness = this.witness(key);
    if (witness.bucketId !== expectedBucket) {
      throw new Error(`${this.setId} event carries the wrong bucket`);
    }
    const update = verifySparseSetUpdate({
      domain: witness.domain,
      key,
      storedRoot: witness.storedRoot,
      proof: witness.proof,
    });
    if (update.newRoot !== expectedRoot) {
      throw new Error(`${this.setId} event root does not match local replay`);
    }
  }

  insert(key: bigint, expectedBucket: number, expectedRoot: bigint): () => void {
    this.preview(key, expectedBucket, expectedRoot);
    return this.commit(key, expectedBucket, expectedRoot);
  }

  commit(key: bigint, expectedBucket: number, expectedRoot: bigint): () => void {
    const { bucketId } = deriveSparseSetCoordinates(key);
    if (bucketId !== expectedBucket) {
      throw new Error(`${this.setId} event carries the wrong bucket`);
    }
    if (this.keys.has(key)) throw new Error(`${this.setId} event replays a duplicate key`);
    let bucket = this.buckets.get(bucketId);
    const hadBucket = bucket !== undefined;
    if (bucket === undefined) {
      bucket = new SparseBucketIndex(sparseSetDomain(this.setId));
      this.buckets.set(bucketId, bucket);
    }
    const previousRootNode = bucket.checkpointRoot();
    const previousRoot = this.roots[bucketId] as bigint;
    bucket.commit(key, deriveSparseSetCoordinates(key).path, expectedRoot);
    this.keys.add(key);
    this.roots[bucketId] = bucket.root();
    return () => {
      this.keys.delete(key);
      this.roots[bucketId] = previousRoot;
      if (hadBucket) {
        bucket.restoreRoot(previousRootNode);
      } else {
        this.buckets.delete(bucketId);
      }
    };
  }

  snapshot(): SerializedSparseSetIndex {
    return {
      roots: [...this.roots],
      keys: [...this.keys],
      buckets: [...this.buckets].map(([bucketId, bucket]) => {
        const node = bucket.snapshot();
        if (node === null) throw new Error("materialized sparse bucket is empty");
        return [bucketId, node] as const;
      }),
    };
  }

  restore(snapshot: SerializedSparseSetIndex): void {
    if (snapshot.roots.length !== SPARSE_SET_BUCKET_COUNT) {
      throw new Error("sparse index snapshot has an invalid root table");
    }
    this.keys.clear();
    for (const key of snapshot.keys) {
      deriveSparseSetCoordinates(key);
      this.keys.add(key);
    }
    this.buckets.clear();
    this.roots.splice(0, this.roots.length, ...snapshot.roots);
    for (const [bucketId, node] of snapshot.buckets) {
      if (!Number.isInteger(bucketId) || bucketId < 0 || bucketId >= 256) {
        throw new Error("sparse index snapshot has an invalid bucket id");
      }
      const bucket = new SparseBucketIndex(sparseSetDomain(this.setId));
      bucket.restore(node);
      if (bucket.root() !== this.roots[bucketId]) {
        throw new Error("sparse index snapshot root table mismatch");
      }
      this.buckets.set(bucketId, bucket);
    }
  }

  *compactLeaves(): Generator<CompactSparseLeaf> {
    const buckets = [...this.buckets].sort(([a], [b]) => a - b);
    for (const [, bucket] of buckets) yield* bucket.compactLeaves();
  }

  beginCompactRestore(roots: readonly bigint[]): void {
    if (roots.length !== SPARSE_SET_BUCKET_COUNT) {
      throw new Error("compact sparse root table has an invalid length");
    }
    this.keys.clear();
    this.buckets.clear();
    this.roots.splice(0, this.roots.length, ...roots);
  }

  restoreCompactLeaf(leaf: CompactSparseLeaf): void {
    const { bucketId } = deriveSparseSetCoordinates(leaf.key);
    if (this.keys.has(leaf.key)) {
      throw new Error("compact sparse snapshot contains a duplicate key");
    }
    let bucket = this.buckets.get(bucketId);
    if (bucket === undefined) {
      bucket = new SparseBucketIndex(sparseSetDomain(this.setId));
      this.buckets.set(bucketId, bucket);
    }
    bucket.restoreCompactLeaf(leaf.key, leaf.leafHash);
    this.keys.add(leaf.key);
  }

  finishCompactRestore(): void {
    for (let bucketId = 0; bucketId < SPARSE_SET_BUCKET_COUNT; bucketId += 1) {
      const bucket = this.buckets.get(bucketId);
      const expectedRoot = this.roots[bucketId] as bigint;
      if (bucket === undefined) {
        if (expectedRoot !== 0n) {
          throw new Error("compact sparse snapshot omits a non-empty bucket");
        }
      } else {
        bucket.finalizeCompactRoot(expectedRoot);
      }
    }
  }
}

function comparePosition(a: ReplayPosition, b: ReplayPosition): number {
  if (a.transactionLt !== b.transactionLt) {
    return a.transactionLt < b.transactionLt ? -1 : 1;
  }
  if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
  return a.blockSeqno - b.blockSeqno;
}

function clonePosition(position: ReplayPosition): ReplayPosition {
  return { ...position };
}

const INITIAL_POSITION: ReplayPosition = {
  blockSeqno: 0,
  transactionLt: 0n,
  eventIndex: 0,
};

export class LocalMerkleStateProvider implements MerkleStateProvider {
  readonly privacyMode = "local" as const;
  private readonly commitmentSet = new SparseSetIndex("commitment");
  private readonly nullifierSet = new SparseSetIndex("nullifier");
  private readonly poseidonLayers: Map<number, bigint>[];
  private readonly zeros: bigint[];
  private position = clonePosition(INITIAL_POSITION);
  private nextIndex = 0;
  private withdrawalCount = 0;
  private currentRoot: bigint;
  private verified = false;
  private hasVerifiedCheckpoint = false;
  private readonly dirtySparseBuckets = new Set<string>();
  private pendingPersistence: {
    batch: MerkleStateEventBatch;
    checkpoint: MerkleStateCheckpoint;
  } | null = null;

  private constructor(private readonly options: LocalMerkleStateProviderOptions, zeros: bigint[]) {
    this.zeros = zeros;
    this.currentRoot = zeros[TREE_DEPTH] as bigint;
    this.poseidonLayers = Array.from(
      { length: TREE_DEPTH + 1 },
      () => new Map<number, bigint>(),
    );
  }

  static async create(
    options: LocalMerkleStateProviderOptions,
  ): Promise<LocalMerkleStateProvider> {
    const zeros = await emptyZeros(options.poseidon2, TREE_DEPTH);
    const provider = new LocalMerkleStateProvider(options, zeros);
    const snapshot = options.snapshot ??
      await options.store?.load?.(options.poolAddress);
    if (snapshot !== undefined && snapshot !== null) {
      await provider.restore(snapshot);
    } else {
      const compact = await options.store?.loadCompact?.(options.poolAddress);
      if (compact !== undefined && compact !== null) {
        await provider.restoreCompactSnapshot(compact);
      }
    }
    const journal = await options.store?.loadVerifiedBatches?.(
      options.poolAddress,
      clonePosition(provider.position),
    );
    if (journal !== undefined) {
      for await (const entry of journal) await provider.restoreJournalEntry(entry);
    }
    return provider;
  }

  private async restoreCompactSnapshot(chunks: CompactSnapshotChunks): Promise<void> {
    let restoredCheckpoint: MerkleStateCheckpoint | null = null;
    const sink: CompactMerkleSnapshotSink = {
      begin: (checkpoint) => {
        if (checkpoint.poolAddress !== this.options.poolAddress) {
          throw new Error("compact snapshot belongs to another pool");
        }
        restoredCheckpoint = checkpoint;
        for (const layer of this.poseidonLayers) layer.clear();
        this.commitmentSet.beginCompactRestore(checkpoint.commitmentSeenRoots);
        this.nullifierSet.beginCompactRestore(checkpoint.nullifierSpentRoots);
        this.nextIndex = checkpoint.nextIndex;
        this.withdrawalCount = checkpoint.withdrawalCount;
        this.currentRoot = checkpoint.currentRoot;
        this.position = clonePosition(checkpoint.position);
      },
      poseidonNode: ({ level, index, value }) => {
        const layer = this.poseidonLayers[level] as Map<number, bigint>;
        if (layer.has(index)) throw new Error("compact snapshot repeats a Poseidon node");
        layer.set(index, value);
      },
      sparseLeaf: (setId, leaf) => {
        (setId === "commitment" ? this.commitmentSet : this.nullifierSet)
          .restoreCompactLeaf(leaf);
      },
      end: () => {
        if (restoredCheckpoint === null) throw new Error("compact snapshot has no checkpoint");
        this.commitmentSet.finishCompactRestore();
        this.nullifierSet.finishCompactRestore();
        const leafLayer = this.poseidonLayers[0] as Map<number, bigint>;
        for (let index = 0; index < this.nextIndex; index += 1) {
          if (!leafLayer.has(index)) {
            throw new Error("compact snapshot Poseidon leaves are not contiguous");
          }
        }
        if (
          this.poseidonLayers[0]?.size !== this.nextIndex ||
          this.commitmentSet.keys.size !== this.nextIndex ||
          this.nullifierSet.keys.size !== this.withdrawalCount ||
          this.poseidonNode(TREE_DEPTH, 0) !== this.currentRoot ||
          !sameCheckpoint(this.buildCheckpoint(), restoredCheckpoint)
        ) {
          throw new Error("compact snapshot contents do not match its checkpoint");
        }
      },
    };
    await decodeCompactSnapshotChunks(chunks, sink);
    this.dirtySparseBuckets.clear();
    this.verified = false;
    this.hasVerifiedCheckpoint = false;
  }

  private async restoreJournalEntry(entry: PersistedMerkleStateBatch): Promise<void> {
    validateMerkleStateCheckpoint(entry.checkpoint);
    if (entry.checkpoint.poolAddress !== this.options.poolAddress) {
      throw new Error("journal checkpoint belongs to another pool");
    }
    if (
      comparePosition(entry.batch.scannedThrough, entry.checkpoint.position) !== 0 ||
      comparePosition(entry.checkpoint.position, this.position) <= 0
    ) {
      throw new Error("journal checkpoint position is not the next replay cursor");
    }
    const incoming = [...entry.batch.events]
      .sort((a, b) => comparePosition(a.position, b.position));
    const undo: (() => void)[] = [];
    const previousPosition = this.position;
    const previousVerified = this.verified;
    try {
      let cursor = this.position;
      for (const indexed of incoming) {
        if (
          comparePosition(indexed.position, cursor) <= 0 ||
          comparePosition(indexed.position, entry.checkpoint.position) > 0
        ) {
          throw new Error("journal event position is outside its checkpoint range");
        }
        undo.push(await this.apply(indexed));
        cursor = indexed.position;
      }
      this.position = clonePosition(entry.checkpoint.position);
      const rebuilt = this.buildCheckpoint();
      if (!sameCheckpoint(rebuilt, entry.checkpoint)) {
        throw new Error("journal batch does not reconstruct its checkpoint");
      }
      this.verified = false;
    } catch (error) {
      for (let index = undo.length - 1; index >= 0; index -= 1) undo[index]?.();
      this.position = previousPosition;
      this.verified = previousVerified;
      throw error;
    }
  }

  private assertVerified(): void {
    if (!this.verified) {
      throw new Error("Merkle state checkpoint must be verified on-chain before use");
    }
  }

  private poseidonNode(level: number, index: number): bigint {
    return this.poseidonLayers[level]?.get(index) ?? (this.zeros[level] as bigint);
  }

  private async appendDeposit(
    leafIndex: number,
    commitment: bigint,
    expectedRoot?: bigint,
  ): Promise<() => void> {
    if (leafIndex !== this.nextIndex || leafIndex >= TREE_CAPACITY) {
      throw new Error("deposit event is not the next depth-20 leaf");
    }
    const parents: { level: number; index: number; node: bigint }[] = [];
    let index = leafIndex;
    let node = commitment;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const parent = index >> 1;
      const sibling = this.poseidonNode(level, index ^ 1);
      node = (index & 1) === 0
        ? await this.options.poseidon2(node, sibling)
        : await this.options.poseidon2(sibling, node);
      parents.push({ level: level + 1, index: parent, node });
      index = parent;
    }
    if (expectedRoot !== undefined && node !== expectedRoot) {
      throw new Error("deposit event Poseidon root does not match local replay");
    }
    const touched: {
      layer: Map<number, bigint>;
      index: number;
      previous: bigint | undefined;
    }[] = [];
    const leafLayer = this.poseidonLayers[0] as Map<number, bigint>;
    touched.push({ layer: leafLayer, index: leafIndex, previous: leafLayer.get(leafIndex) });
    leafLayer.set(leafIndex, commitment);
    for (const parent of parents) {
      const layer = this.poseidonLayers[parent.level] as Map<number, bigint>;
      touched.push({ layer, index: parent.index, previous: layer.get(parent.index) });
      layer.set(parent.index, parent.node);
    }
    const previousRoot = this.currentRoot;
    const previousNextIndex = this.nextIndex;
    this.currentRoot = node;
    this.nextIndex += 1;
    return () => {
      for (let index = touched.length - 1; index >= 0; index -= 1) {
        const entry = touched[index] as (typeof touched)[number];
        if (entry.previous === undefined) entry.layer.delete(entry.index);
        else entry.layer.set(entry.index, entry.previous);
      }
      this.currentRoot = previousRoot;
      this.nextIndex = previousNextIndex;
    };
  }

  private async apply(indexed: IndexedPoolEvent): Promise<() => void> {
    const undo: (() => void)[] = [];
    const previousPosition = this.position;
    const previousVerified = this.verified;
    const event = indexed.event;
    try {
      if (event.kind === "deposit") {
        this.commitmentSet.preview(
          event.commitment,
          event.sparseUpdate.bucketId,
          event.sparseUpdate.newRoot,
        );
        undo.push(await this.appendDeposit(
          event.leafIndex,
          event.commitment,
          event.newRoot,
        ));
        undo.push(this.commitmentSet.commit(
          event.commitment,
          event.sparseUpdate.bucketId,
          event.sparseUpdate.newRoot,
        ));
        const dirty = `commitment:${event.sparseUpdate.bucketId}`;
        const wasDirty = this.dirtySparseBuckets.has(dirty);
        this.dirtySparseBuckets.add(dirty);
        if (!wasDirty) undo.push(() => this.dirtySparseBuckets.delete(dirty));
      } else if (event.kind === "ton-withdraw" || event.kind === "jetton-withdraw") {
        undo.push(this.nullifierSet.insert(
          event.nullifierHash,
          event.sparseUpdate.bucketId,
          event.sparseUpdate.newRoot,
        ));
        const dirty = `nullifier:${event.sparseUpdate.bucketId}`;
        const wasDirty = this.dirtySparseBuckets.has(dirty);
        this.dirtySparseBuckets.add(dirty);
        if (!wasDirty) undo.push(() => this.dirtySparseBuckets.delete(dirty));
        this.withdrawalCount += 1;
        undo.push(() => { this.withdrawalCount -= 1; });
      }
      this.position = clonePosition(indexed.position);
      this.verified = false;
      return () => {
        this.position = previousPosition;
        this.verified = previousVerified;
        for (let index = undo.length - 1; index >= 0; index -= 1) {
          undo[index]?.();
        }
      };
    } catch (error) {
      for (let index = undo.length - 1; index >= 0; index -= 1) {
        undo[index]?.();
      }
      throw error;
    }
  }

  private async restore(snapshot: LocalMerkleStateSnapshot): Promise<void> {
    validateLocalSnapshot(snapshot);
    if (snapshot.checkpoint.poolAddress !== this.options.poolAddress) {
      throw new Error("snapshot belongs to another pool");
    }
    for (const [level, entries] of snapshot.poseidonLayers.entries()) {
      const layer = this.poseidonLayers[level] as Map<number, bigint>;
      layer.clear();
      for (const [index, node] of entries) layer.set(index, node);
    }
    this.commitmentSet.restore(snapshot.commitmentIndex);
    this.nullifierSet.restore(snapshot.nullifierIndex);
    this.nextIndex = snapshot.checkpoint.nextIndex;
    this.withdrawalCount = snapshot.checkpoint.withdrawalCount;
    this.currentRoot = snapshot.checkpoint.currentRoot;
    this.position = clonePosition(snapshot.checkpoint.position);
    if (
      this.poseidonLayers[0]?.size !== this.nextIndex ||
      this.poseidonNode(TREE_DEPTH, 0) !== this.currentRoot
    ) {
      throw new Error("local snapshot node layers do not match its checkpoint");
    }
    const rebuilt = this.buildCheckpoint();
    const comparable = { ...rebuilt, position: snapshot.checkpoint.position };
    if (!sameCheckpoint(comparable, snapshot.checkpoint)) {
      throw new Error("local snapshot contents do not match its checkpoint");
    }
    this.verified = false;
  }

  private buildCheckpoint(): MerkleStateCheckpoint {
    return {
      schemaVersion: 1,
      poolAddress: this.options.poolAddress,
      position: clonePosition(this.position),
      nextIndex: this.nextIndex,
      withdrawalCount: this.withdrawalCount,
      currentRoot: this.currentRoot,
      commitmentSeenRoots: [...this.commitmentSet.roots],
      nullifierSpentRoots: [...this.nullifierSet.roots],
    };
  }

  async sync(target: MerkleStateSyncTarget): Promise<MerkleStateCheckpoint> {
    if (this.pendingPersistence !== null) {
      const pending = this.pendingPersistence;
      if (this.options.store?.appendVerifiedBatch === undefined) {
        throw new Error("verified replay batch is pending without a journal store");
      }
      await this.options.store.appendVerifiedBatch(
        this.options.poolAddress,
        pending.batch,
        pending.checkpoint,
      );
      this.position = clonePosition(pending.checkpoint.position);
      this.pendingPersistence = null;
      this.verified = true;
    }
    if (target.poolAddress !== this.options.poolAddress) {
      throw new Error("sync target belongs to another pool");
    }
    const replayStartPosition = clonePosition(this.position);
    const batch = await this.options.source.eventsAfter(
      this.options.poolAddress,
      this.position,
    );
    if (comparePosition(this.position, batch.scannedThrough) > 0) {
      throw new Error("snapshot replay cursor is ahead of the event source head");
    }
    const incoming = [...batch.events]
      .sort((a, b) => comparePosition(a.position, b.position));
    const undo: (() => void)[] = [];
    const rollbackVerified = this.verified;
    const rollbackHasVerifiedCheckpoint = this.hasVerifiedCheckpoint;
    try {
      let previous = this.position;
      for (const indexed of incoming) {
        if (
          comparePosition(indexed.position, previous) <= 0 ||
          comparePosition(indexed.position, batch.scannedThrough) > 0
        ) {
          throw new Error("event source returned a duplicate or non-increasing replay position");
        }
        undo.push(await this.apply(indexed));
        previous = indexed.position;
      }

      const checkpoint = this.buildCheckpoint();
      validateMerkleStateCheckpoint(checkpoint);
      if (
        checkpoint.nextIndex !== target.nextIndex ||
        checkpoint.withdrawalCount !== target.withdrawalCount ||
        checkpoint.currentRoot !== target.currentRoot
      ) {
        throw new Error("replayed state does not reach the requested on-chain head");
      }
      const verification = this.hasVerifiedCheckpoint
        ? await this.verifyIncrementalCheckpoint(checkpoint)
        : await verifyHeadCheckpoint(checkpoint, this.options.chain);
      if (!verification.valid) {
        throw new Error(
          `checkpoint does not match on-chain getters: ${verification.mismatches
            .map((mismatch) => mismatch.field)
            .join(", ")}`,
        );
      }
      this.hasVerifiedCheckpoint = true;
      this.dirtySparseBuckets.clear();
    } catch (error) {
      for (let index = undo.length - 1; index >= 0; index -= 1) {
        undo[index]?.();
      }
      this.verified = rollbackVerified;
      this.hasVerifiedCheckpoint = rollbackHasVerifiedCheckpoint;
      throw error;
    }
    const nextPosition = comparePosition(batch.scannedThrough, this.position) > 0
      ? batch.scannedThrough
      : this.position;
    const verifiedCheckpoint = {
      ...this.buildCheckpoint(),
      position: clonePosition(nextPosition),
    };
    if (
      this.options.store?.appendVerifiedBatch !== undefined &&
      comparePosition(nextPosition, replayStartPosition) > 0
    ) {
      try {
        await this.options.store.appendVerifiedBatch(
          this.options.poolAddress,
          batch,
          verifiedCheckpoint,
        );
      } catch (error) {
        this.pendingPersistence = { batch, checkpoint: verifiedCheckpoint };
        this.verified = false;
        throw error;
      }
    }
    this.position = clonePosition(nextPosition);
    this.verified = true;
    return verifiedCheckpoint;
  }

  async checkpoint(): Promise<MerkleStateCheckpoint> {
    this.assertVerified();
    return this.buildCheckpoint();
  }

  async insertionPath(nextIndex: number): Promise<PoseidonInsertPath> {
    this.assertVerified();
    if (nextIndex !== this.nextIndex || nextIndex >= TREE_CAPACITY) {
      throw new Error("requested insertion index is not the verified tree head");
    }
    const path = this.pathFor(nextIndex);
    if (await this.foldPoseidonPath(this.zeros[0] as bigint, path) !== this.currentRoot) {
      this.verified = false;
      throw new Error("local insertion path does not match the verified root");
    }
    return {
      nextIndex,
      currentRoot: this.currentRoot,
      path,
    };
  }

  async membershipPath(leafIndex: number): Promise<PoseidonMembershipPath> {
    this.assertVerified();
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= this.nextIndex) {
      throw new RangeError("leafIndex is not present in the verified tree");
    }
    const leaf = this.poseidonLayers[0]?.get(leafIndex);
    if (leaf === undefined) throw new Error("local membership leaf is missing");
    const path = this.pathFor(leafIndex);
    if (await this.foldPoseidonPath(leaf, path) !== this.currentRoot) {
      this.verified = false;
      throw new Error("local membership path does not match the verified root");
    }
    return {
      leafIndex,
      currentRoot: this.currentRoot,
      path,
    };
  }

  private pathFor(leafIndex: number) {
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let index = leafIndex;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      pathElements.push(this.poseidonNode(level, index ^ 1));
      pathIndices.push(index & 1);
      index >>= 1;
    }
    return { pathElements, pathIndices };
  }

  private async foldPoseidonPath(
    leaf: bigint,
    path: { pathElements: readonly bigint[]; pathIndices: readonly number[] },
  ): Promise<bigint> {
    let node = leaf;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const sibling = path.pathElements[level];
      const direction = path.pathIndices[level];
      if (sibling === undefined || (direction !== 0 && direction !== 1)) {
        throw new Error("local Poseidon path is malformed");
      }
      node = direction === 0
        ? await this.options.poseidon2(node, sibling)
        : await this.options.poseidon2(sibling, node);
    }
    return node;
  }

  async sparseSetWitness(setId: SparseSetId, key: bigint): Promise<SparseSetWitness> {
    this.assertVerified();
    const witness = setId === "commitment"
      ? this.commitmentSet.witness(key)
      : this.nullifierSet.witness(key);
    verifySparseSetUpdate({
      domain: witness.domain,
      key: witness.key,
      storedRoot: witness.storedRoot,
      proof: witness.proof,
    });
    const onChainRoot = await this.options.chain.getSparseRoot(
      this.options.poolAddress,
      setId,
      witness.bucketId,
    );
    if (onChainRoot !== witness.storedRoot) {
      this.verified = false;
      throw new Error(
        `${setId} bucket ${witness.bucketId} changed without a replayed event`,
      );
    }
    return witness;
  }

  private *compactPoseidonNodes(): Generator<CompactPoseidonNode> {
    for (const [level, layer] of this.poseidonLayers.entries()) {
      for (const [index, value] of layer) yield { level, index, value };
    }
  }

  compactSnapshotSource(): CompactMerkleSnapshotSource {
    this.assertVerified();
    return {
      checkpoint: this.buildCheckpoint(),
      poseidonNodeCount: this.poseidonLayers.reduce(
        (count, layer) => count + layer.size,
        0,
      ),
      poseidonNodes: this.compactPoseidonNodes(),
      commitmentLeafCount: this.commitmentSet.keys.size,
      commitmentLeaves: this.commitmentSet.compactLeaves(),
      nullifierLeafCount: this.nullifierSet.keys.size,
      nullifierLeaves: this.nullifierSet.compactLeaves(),
    };
  }

  exportCompactSnapshotChunks(chunkSize?: number): Iterable<Uint8Array> {
    return encodeCompactSnapshotChunks(this.compactSnapshotSource(), chunkSize);
  }

  exportSnapshot(): LocalMerkleStateSnapshot {
    this.assertVerified();
    return {
      schemaVersion: 3,
      checkpoint: this.buildCheckpoint(),
      poseidonLayers: this.poseidonLayers.map((layer) => [...layer]),
      commitmentIndex: this.commitmentSet.snapshot(),
      nullifierIndex: this.nullifierSet.snapshot(),
    };
  }

  async saveSnapshot(): Promise<LocalMerkleStateSnapshot> {
    this.assertVerified();
    const snapshot = this.exportSnapshot();
    if (this.options.store?.save === undefined) {
      throw new Error("snapshot store does not implement full compaction");
    }
    await this.options.store.save(snapshot);
    return snapshot;
  }

  async saveCompactSnapshot(chunkSize?: number): Promise<MerkleStateCheckpoint> {
    this.assertVerified();
    if (this.options.store?.saveCompact === undefined) {
      throw new Error("snapshot store does not implement compact compaction");
    }
    const checkpoint = this.buildCheckpoint();
    await this.options.store.saveCompact(
      this.options.poolAddress,
      this.exportCompactSnapshotChunks(chunkSize),
    );
    return checkpoint;
  }

  private async verifyIncrementalCheckpoint(
    checkpoint: MerkleStateCheckpoint,
  ) {
    const mismatches: {
      field: string;
      expected: bigint | number;
      actual: bigint | number;
    }[] = [];
    const head = await this.options.chain.getMerkleHead(this.options.poolAddress);
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
    for (const dirty of this.dirtySparseBuckets) {
      const [setId, rawBucket] = dirty.split(":") as [SparseSetId, string];
      const bucketId = Number(rawBucket);
      const localRoot = setId === "commitment"
        ? this.commitmentSet.roots[bucketId]
        : this.nullifierSet.roots[bucketId];
      const onChainRoot = await this.options.chain.getSparseRoot(
        this.options.poolAddress,
        setId,
        bucketId,
      );
      if (onChainRoot !== localRoot) {
        mismatches.push({
          field: `${setId}Roots[${bucketId}]`,
          expected: onChainRoot,
          actual: localRoot as bigint,
        });
      }
    }
    return { valid: mismatches.length === 0, mismatches };
  }
}

function sameBigintArray(a: readonly bigint[], b: readonly bigint[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameCheckpoint(a: MerkleStateCheckpoint, b: MerkleStateCheckpoint): boolean {
  return a.poolAddress === b.poolAddress &&
    a.nextIndex === b.nextIndex &&
    a.withdrawalCount === b.withdrawalCount &&
    a.currentRoot === b.currentRoot &&
    sameBigintArray(a.commitmentSeenRoots, b.commitmentSeenRoots) &&
    sameBigintArray(a.nullifierSpentRoots, b.nullifierSpentRoots);
}
