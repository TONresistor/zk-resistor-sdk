import type {
  MerkleStateCheckpoint,
  SparseSetId,
} from "./state-provider.js";
import { validateMerkleStateCheckpoint } from "./state-provider.js";

const MAGIC = new TextEncoder().encode("ZKRSNP2\0");
const FORMAT_VERSION = 2;
const SECTION_POSEIDON = 1;
const SECTION_COMMITMENTS = 2;
const SECTION_NULLIFIERS = 3;
const SECTION_END = 0xff;
const UINT64_LIMIT = 1n << 64n;
const UINT256_LIMIT = 1n << 256n;

export interface CompactPoseidonNode {
  level: number;
  index: number;
  value: bigint;
}

export interface CompactSparseLeaf {
  key: bigint;
  leafHash: bigint;
}

export interface CompactMerkleSnapshotSource {
  checkpoint: MerkleStateCheckpoint;
  poseidonNodeCount: number;
  poseidonNodes: Iterable<CompactPoseidonNode>;
  commitmentLeafCount: number;
  commitmentLeaves: Iterable<CompactSparseLeaf>;
  nullifierLeafCount: number;
  nullifierLeaves: Iterable<CompactSparseLeaf>;
}

type MaybePromise = void | Promise<void>;

/** Streaming sink; database implementations can batch writes internally. */
export interface CompactMerkleSnapshotSink {
  begin(checkpoint: MerkleStateCheckpoint): MaybePromise;
  poseidonNode(node: CompactPoseidonNode): MaybePromise;
  sparseLeaf(setId: SparseSetId, leaf: CompactSparseLeaf): MaybePromise;
  end(): MaybePromise;
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function uint8(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError("value must be a uint8");
  }
  return Uint8Array.of(value);
}

function uint16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError("value must be a uint16");
  }
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function uint32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError("value must be a uint32");
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function fixedBigUint(value: bigint, bytes: 8 | 32): Uint8Array {
  const limit = bytes === 8 ? UINT64_LIMIT : UINT256_LIMIT;
  if (value < 0n || value >= limit) {
    throw new RangeError(`value must be a uint${bytes * 8}`);
  }
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (bytes === 8) {
    view.setBigUint64(0, value, false);
  } else {
    view.setBigUint64(0, value >> 192n, false);
    view.setBigUint64(8, (value >> 128n) & (UINT64_LIMIT - 1n), false);
    view.setBigUint64(16, (value >> 64n) & (UINT64_LIMIT - 1n), false);
    view.setBigUint64(24, value & (UINT64_LIMIT - 1n), false);
  }
  return out;
}

function text(value: string): readonly Uint8Array[] {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > 0xffff) throw new RangeError("snapshot string is too long");
  return [uint16(encoded.length), encoded];
}

function* checkpointParts(
  checkpoint: MerkleStateCheckpoint,
): Generator<Uint8Array> {
  validateMerkleStateCheckpoint(checkpoint);
  yield* text(checkpoint.poolAddress);
  yield uint32(checkpoint.position.blockSeqno);
  yield fixedBigUint(checkpoint.position.transactionLt, 8);
  yield uint32(checkpoint.position.eventIndex);
  yield uint32(checkpoint.nextIndex);
  yield uint32(checkpoint.withdrawalCount);
  yield fixedBigUint(checkpoint.currentRoot, 32);
  for (const root of checkpoint.commitmentSeenRoots) yield fixedBigUint(root, 32);
  for (const root of checkpoint.nullifierSpentRoots) yield fixedBigUint(root, 32);
}

function* counted<T>(
  name: string,
  expected: number,
  values: Iterable<T>,
): Generator<T> {
  assertCount(name, expected);
  let actual = 0;
  for (const value of values) {
    actual += 1;
    if (actual > expected) throw new Error(`${name} exceeds its declared count`);
    yield value;
  }
  if (actual !== expected) {
    throw new Error(`${name} count ${actual} does not match declared ${expected}`);
  }
}

function* snapshotParts(
  source: CompactMerkleSnapshotSource,
): Generator<Uint8Array> {
  yield MAGIC;
  yield uint16(FORMAT_VERSION);
  yield* checkpointParts(source.checkpoint);

  yield uint8(SECTION_POSEIDON);
  yield fixedBigUint(BigInt(source.poseidonNodeCount), 8);
  for (const node of counted(
    "poseidon nodes",
    source.poseidonNodeCount,
    source.poseidonNodes,
  )) {
    if (!Number.isInteger(node.level) || node.level < 0 || node.level > 20) {
      throw new RangeError("Poseidon node level is invalid");
    }
    if (!Number.isInteger(node.index) || node.index < 0 ||
      node.index >= 2 ** (20 - node.level)) {
      throw new RangeError("Poseidon node index is invalid for its level");
    }
    yield uint8(node.level);
    yield uint32(node.index);
    yield fixedBigUint(node.value, 32);
  }

  for (const [tag, name, expected, leaves] of [
    [
      SECTION_COMMITMENTS,
      "commitment leaves",
      source.commitmentLeafCount,
      source.commitmentLeaves,
    ],
    [
      SECTION_NULLIFIERS,
      "nullifier leaves",
      source.nullifierLeafCount,
      source.nullifierLeaves,
    ],
  ] as const) {
    yield uint8(tag);
    yield fixedBigUint(BigInt(expected), 8);
    for (const leaf of counted(name, expected, leaves)) {
      yield fixedBigUint(leaf.key, 32);
      yield fixedBigUint(leaf.leafHash, 32);
    }
  }

  yield uint8(SECTION_END);
}

/** Encodes a snapshot with bounded memory and fixed-size output chunks. */
export function* encodeCompactSnapshotChunks(
  source: CompactMerkleSnapshotSource,
  chunkSize = 1 << 20,
): Generator<Uint8Array> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 64) {
    throw new RangeError("chunkSize must be an integer of at least 64 bytes");
  }
  let chunk = new Uint8Array(chunkSize);
  let offset = 0;
  for (const part of snapshotParts(source)) {
    let partOffset = 0;
    while (partOffset < part.length) {
      const copied = Math.min(chunk.length - offset, part.length - partOffset);
      chunk.set(part.subarray(partOffset, partOffset + copied), offset);
      offset += copied;
      partOffset += copied;
      if (offset === chunk.length) {
        yield chunk;
        chunk = new Uint8Array(chunkSize);
        offset = 0;
      }
    }
  }
  if (offset !== 0) yield chunk.slice(0, offset);
}

export type CompactSnapshotChunks =
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>;

class AsyncChunkReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private offset = 0;
  private done = false;

  constructor(chunks: CompactSnapshotChunks) {
    this.iterator = (async function* () {
      for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array) || chunk.length === 0) {
          throw new Error("snapshot chunks must be non-empty Uint8Array values");
        }
        yield chunk;
      }
    })()[Symbol.asyncIterator]();
  }

  async readExact(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("read length is invalid");
    }
    if (length === 0) return new Uint8Array(0);
    if (this.current.length - this.offset >= length) {
      const value = this.current.subarray(this.offset, this.offset + length);
      this.offset += length;
      return value;
    }
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.offset === this.current.length) {
        const next = await this.iterator.next();
        if (next.done) {
          this.done = true;
          throw new Error("compact snapshot ended early");
        }
        this.current = next.value;
        this.offset = 0;
      }
      const copied = Math.min(length - written, this.current.length - this.offset);
      result.set(this.current.subarray(this.offset, this.offset + copied), written);
      this.offset += copied;
      written += copied;
    }
    return result;
  }

  async assertEnd(): Promise<void> {
    if (this.offset !== this.current.length) {
      throw new Error("compact snapshot contains trailing bytes");
    }
    if (!this.done) {
      const next = await this.iterator.next();
      if (!next.done) throw new Error("compact snapshot contains trailing chunks");
      this.done = true;
    }
  }
}

function readUint16(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint16(0, false);
}

function readUint32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(0, false);
}

function readFixedBigUint(bytes: Uint8Array): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length === 8) return view.getBigUint64(0, false);
  if (bytes.length !== 32) throw new Error("invalid fixed bigint width");
  return (view.getBigUint64(0, false) << 192n) |
    (view.getBigUint64(8, false) << 128n) |
    (view.getBigUint64(16, false) << 64n) |
    view.getBigUint64(24, false);
}

async function readText(reader: AsyncChunkReader): Promise<string> {
  const length = readUint16(await reader.readExact(2));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await reader.readExact(length),
  );
}

function safeCount(value: bigint, name: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} exceeds the JavaScript safe integer range`);
  }
  return Number(value);
}

async function readCheckpoint(
  reader: AsyncChunkReader,
): Promise<MerkleStateCheckpoint> {
  const poolAddress = await readText(reader);
  const blockSeqno = readUint32(await reader.readExact(4));
  const transactionLt = readFixedBigUint(await reader.readExact(8));
  const eventIndex = readUint32(await reader.readExact(4));
  const nextIndex = readUint32(await reader.readExact(4));
  const withdrawalCount = readUint32(await reader.readExact(4));
  const currentRoot = readFixedBigUint(await reader.readExact(32));
  const commitmentSeenRoots: bigint[] = [];
  const nullifierSpentRoots: bigint[] = [];
  for (let index = 0; index < 256; index += 1) {
    commitmentSeenRoots.push(readFixedBigUint(await reader.readExact(32)));
  }
  for (let index = 0; index < 256; index += 1) {
    nullifierSpentRoots.push(readFixedBigUint(await reader.readExact(32)));
  }
  const checkpoint: MerkleStateCheckpoint = {
    schemaVersion: 1,
    poolAddress,
    position: { blockSeqno, transactionLt, eventIndex },
    nextIndex,
    withdrawalCount,
    currentRoot,
    commitmentSeenRoots,
    nullifierSpentRoots,
  };
  validateMerkleStateCheckpoint(checkpoint);
  return checkpoint;
}

async function expectSection(reader: AsyncChunkReader, expected: number): Promise<number> {
  const tag = (await reader.readExact(1))[0];
  if (tag !== expected) throw new Error(`compact snapshot section ${expected} is missing`);
  return safeCount(
    readFixedBigUint(await reader.readExact(8)),
    `section ${expected} count`,
  );
}

/** Decodes directly into a sink, without materializing the complete snapshot. */
export async function decodeCompactSnapshotChunks(
  chunks: CompactSnapshotChunks,
  sink: CompactMerkleSnapshotSink,
): Promise<MerkleStateCheckpoint> {
  const reader = new AsyncChunkReader(chunks);
  const magic = await reader.readExact(MAGIC.length);
  if (!magic.every((byte, index) => byte === MAGIC[index])) {
    throw new Error("invalid compact snapshot magic");
  }
  const version = readUint16(await reader.readExact(2));
  if (version !== FORMAT_VERSION) {
    if (version === 1) {
      throw new Error(
        "compact snapshot format 1 contains removed recovery state; rebuild it from chain",
      );
    }
    throw new Error(`unsupported compact snapshot format ${version}`);
  }
  const checkpoint = await readCheckpoint(reader);
  const begin = sink.begin(checkpoint);
  if (begin !== undefined) await begin;

  const poseidonCount = await expectSection(reader, SECTION_POSEIDON);
  for (let index = 0; index < poseidonCount; index += 1) {
    const record = await reader.readExact(37);
    const level = record[0] as number;
    if (level > 20) throw new Error("compact snapshot Poseidon level is invalid");
    const nodeIndex = readUint32(record.subarray(1, 5));
    if (nodeIndex >= 2 ** (20 - level)) {
      throw new Error("compact snapshot Poseidon index is invalid");
    }
    const pending = sink.poseidonNode({
      level,
      index: nodeIndex,
      value: readFixedBigUint(record.subarray(5, 37)),
    });
    if (pending !== undefined) await pending;
  }

  for (const [tag, setId] of [
    [SECTION_COMMITMENTS, "commitment"],
    [SECTION_NULLIFIERS, "nullifier"],
  ] as const) {
    const count = await expectSection(reader, tag);
    for (let index = 0; index < count; index += 1) {
      const record = await reader.readExact(64);
      const pending = sink.sparseLeaf(setId, {
        key: readFixedBigUint(record.subarray(0, 32)),
        leafHash: readFixedBigUint(record.subarray(32, 64)),
      });
      if (pending !== undefined) await pending;
    }
  }

  const end = (await reader.readExact(1))[0];
  if (end !== SECTION_END) throw new Error("compact snapshot end marker is missing");
  await reader.assertEnd();
  const endResult = sink.end();
  if (endResult !== undefined) await endResult;
  return checkpoint;
}
