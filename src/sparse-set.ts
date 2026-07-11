import { beginCell } from "@ton/core";
import type { Cell } from "@ton/core";
import { BLS12_381_R } from "./constants.js";

export const SPARSE_SET_BUCKET_BITS = 8;
export const SPARSE_SET_BUCKET_COUNT = 1 << SPARSE_SET_BUCKET_BITS;
export const SPARSE_SET_DEPTH = 247;
export const SPARSE_SET_LEAF_TAG = 1;
export const SPARSE_SET_NODE_TAG = 2;
export const SPARSE_SET_SIBLINGS_PER_CELL = 3;

export const COMMITMENT_DOMAIN = 0x5a4b4301;
export const NULLIFIER_DOMAIN = 0x5a4b4e01;

const UINT256_LIMIT = 1n << 256n;
const SPARSE_BITMAP_LIMIT = 1n << BigInt(SPARSE_SET_DEPTH);

export interface SparseSetCoordinates {
  bucketId: number;
  path: bigint;
}

export interface SparseSetUpdateProof {
  expectedRoot: bigint;
  siblingBitmap: bigint;
  /** Non-zero siblings in increasing level order. */
  siblings: readonly bigint[];
}

export interface SparseSetFoldResult extends SparseSetCoordinates {
  oldRoot: bigint;
  newRoot: bigint;
}

export interface VerifiedSparseSetUpdate extends SparseSetFoldResult {
  domain: number;
  key: bigint;
  proof: SparseSetUpdateProof;
}

export interface SparseSetCrossVector extends VerifiedSparseSetUpdate {
  siblingsByLevel: readonly bigint[];
  proofCell: Cell;
  proofCellHash: bigint;
  leafHash: bigint;
}

export class SparseSetEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SparseSetEncodingError";
  }
}

export class SparseSetStaleRootError extends Error {
  readonly expectedRoot: bigint;
  readonly storedRoot: bigint;

  constructor(expectedRoot: bigint, storedRoot: bigint) {
    super("Sparse-set witness was built against a stale bucket root");
    this.name = "SparseSetStaleRootError";
    this.expectedRoot = expectedRoot;
    this.storedRoot = storedRoot;
  }
}

export class SparseSetInvalidProofError extends Error {
  readonly reconstructedRoot: bigint;
  readonly expectedRoot: bigint;

  constructor(reconstructedRoot: bigint, expectedRoot: bigint) {
    super("Sparse-set witness does not reconstruct the expected bucket root");
    this.name = "SparseSetInvalidProofError";
    this.reconstructedRoot = reconstructedRoot;
    this.expectedRoot = expectedRoot;
  }
}

function assertUint(name: string, value: bigint, limit: bigint): void {
  if (value < 0n || value >= limit) {
    throw new RangeError(`${name} is outside its unsigned integer range`);
  }
}

function assertDomain(domain: number): void {
  if (!Number.isSafeInteger(domain) || domain < 0 || domain > 0xffffffff) {
    throw new RangeError("sparse-set domain must be a uint32");
  }
}

function assertLevel(level: number, depth: number): void {
  if (!Number.isSafeInteger(level) || level < 0 || level >= depth) {
    throw new RangeError(`level must be between 0 and ${depth - 1}`);
  }
}

function assertOrdinary(cell: Cell, name: string): void {
  if (cell.isExotic) {
    throw new SparseSetEncodingError(`${name} must be an ordinary cell`);
  }
}

export function cellHashToBigInt(cell: Cell): bigint {
  return BigInt(`0x${cell.hash().toString("hex")}`);
}

export function deriveSparseSetCoordinates(key: bigint): SparseSetCoordinates {
  if (key < 0n || key >= BLS12_381_R) {
    throw new RangeError("sparse-set key must be a BLS12-381 scalar field element");
  }

  return {
    bucketId: Number(key & 0xffn),
    path: key >> BigInt(SPARSE_SET_BUCKET_BITS),
  };
}

export function hashSparseSetLeaf(domain: number, key: bigint): bigint {
  assertDomain(domain);
  deriveSparseSetCoordinates(key);

  return cellHashToBigInt(
    beginCell()
      .storeUint(domain, 32)
      .storeUint(SPARSE_SET_LEAF_TAG, 8)
      .storeUint(key, 256)
      .endCell(),
  );
}

export function hashSparseSetNode(
  domain: number,
  level: number,
  left: bigint,
  right: bigint,
): bigint {
  assertDomain(domain);
  assertLevel(level, SPARSE_SET_DEPTH);
  assertUint("left", left, UINT256_LIMIT);
  assertUint("right", right, UINT256_LIMIT);

  if (left === 0n && right === 0n) return 0n;

  return cellHashToBigInt(
    beginCell()
      .storeUint(domain, 32)
      .storeUint(SPARSE_SET_NODE_TAG, 8)
      .storeUint(level, 8)
      .storeUint(left, 256)
      .storeUint(right, 256)
      .endCell(),
  );
}

export function sparseBitmapPopcount(bitmap: bigint): number {
  assertUint("siblingBitmap", bitmap, SPARSE_BITMAP_LIMIT);
  let value = bitmap;
  let count = 0;
  while (value !== 0n) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

function validateCompressedProof(proof: SparseSetUpdateProof): void {
  assertUint("expectedRoot", proof.expectedRoot, UINT256_LIMIT);
  const expectedCount = sparseBitmapPopcount(proof.siblingBitmap);
  if (proof.siblings.length !== expectedCount) {
    throw new SparseSetEncodingError(
      `sibling count ${proof.siblings.length} does not match bitmap popcount ${expectedCount}`,
    );
  }
  for (const sibling of proof.siblings) {
    assertUint("sibling", sibling, UINT256_LIMIT);
    if (sibling === 0n) {
      throw new SparseSetEncodingError(
        "zero siblings must be omitted from the compressed chain",
      );
    }
  }
}

export function compressSparseSetSiblings(
  siblingsByLevel: readonly bigint[],
): Pick<SparseSetUpdateProof, "siblingBitmap" | "siblings"> {
  if (siblingsByLevel.length !== SPARSE_SET_DEPTH) {
    throw new SparseSetEncodingError(
      `sparse-set witness must contain ${SPARSE_SET_DEPTH} levels`,
    );
  }

  let siblingBitmap = 0n;
  const siblings: bigint[] = [];
  for (let level = 0; level < SPARSE_SET_DEPTH; level += 1) {
    const sibling = siblingsByLevel[level];
    if (sibling === undefined) {
      throw new SparseSetEncodingError(`missing sibling at level ${level}`);
    }
    assertUint("sibling", sibling, UINT256_LIMIT);
    if (sibling !== 0n) {
      siblingBitmap |= 1n << BigInt(level);
      siblings.push(sibling);
    }
  }
  return { siblingBitmap, siblings };
}

export function expandSparseSetSiblings(
  proof: SparseSetUpdateProof,
): readonly bigint[] {
  validateCompressedProof(proof);
  const result = new Array<bigint>(SPARSE_SET_DEPTH).fill(0n);
  let siblingIndex = 0;
  for (let level = 0; level < SPARSE_SET_DEPTH; level += 1) {
    if (((proof.siblingBitmap >> BigInt(level)) & 1n) !== 0n) {
      const sibling = proof.siblings[siblingIndex];
      if (sibling === undefined) {
        throw new SparseSetEncodingError("compressed sibling chain ended early");
      }
      result[level] = sibling;
      siblingIndex += 1;
    }
  }
  return result;
}

export function buildPackedUint256Chain(values: readonly bigint[]): Cell {
  for (const value of values) {
    assertUint("packed uint256", value, UINT256_LIMIT);
  }
  if (values.length === 0) return beginCell().endCell();

  const chunks: bigint[][] = [];
  for (let offset = 0; offset < values.length; offset += 3) {
    chunks.push(values.slice(offset, offset + 3));
  }

  let next: Cell | undefined;
  for (let chunkIndex = chunks.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
    const chunk = chunks[chunkIndex];
    if (chunk === undefined) {
      throw new SparseSetEncodingError("missing packed sibling chunk");
    }
    const builder = beginCell();
    for (const value of chunk) builder.storeUint(value, 256);
    if (next !== undefined) builder.storeRef(next);
    next = builder.endCell();
  }

  if (next === undefined) {
    throw new SparseSetEncodingError("failed to build packed sibling chain");
  }
  return next;
}

export function parsePackedUint256Chain(
  chain: Cell,
  expectedCount: number,
): readonly bigint[] {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new RangeError("expectedCount must be a non-negative safe integer");
  }

  const result: bigint[] = [];
  let current = chain;
  let remaining = expectedCount;

  if (remaining === 0) {
    assertOrdinary(current, "empty packed chain");
    const empty = current.beginParse();
    if (empty.remainingBits !== 0 || empty.remainingRefs !== 0) {
      throw new SparseSetEncodingError(
        "zero-value packed chain must be an empty cell",
      );
    }
    return result;
  }

  while (remaining > 0) {
    assertOrdinary(current, "packed chain cell");
    const count = Math.min(SPARSE_SET_SIBLINGS_PER_CELL, remaining);
    const mustContinue = remaining > SPARSE_SET_SIBLINGS_PER_CELL;
    const slice = current.beginParse();
    const requiredRefs = mustContinue ? 1 : 0;
    if (
      slice.remainingBits !== count * 256 ||
      slice.remainingRefs !== requiredRefs
    ) {
      throw new SparseSetEncodingError(
        "packed chain is not in canonical three-values-per-cell form",
      );
    }

    for (let i = 0; i < count; i += 1) {
      const value = slice.loadUintBig(256);
      if (value === 0n) {
        throw new SparseSetEncodingError(
          "zero siblings must be represented by an absent bitmap bit",
        );
      }
      result.push(value);
    }

    remaining -= count;
    if (mustContinue) current = slice.loadRef();
    if (slice.remainingBits !== 0 || slice.remainingRefs !== 0) {
      throw new SparseSetEncodingError("packed chain contains trailing data");
    }
  }

  return result;
}

export function buildSparseSetUpdateProofCell(
  proof: SparseSetUpdateProof,
): Cell {
  validateCompressedProof(proof);
  return beginCell()
    .storeUint(proof.expectedRoot, 256)
    .storeUint(proof.siblingBitmap, SPARSE_SET_DEPTH)
    .storeRef(buildPackedUint256Chain(proof.siblings))
    .endCell();
}

export function parseSparseSetUpdateProofCell(cell: Cell): SparseSetUpdateProof {
  assertOrdinary(cell, "sparse-set proof");
  const slice = cell.beginParse();
  if (
    slice.remainingBits !== 256 + SPARSE_SET_DEPTH ||
    slice.remainingRefs !== 1
  ) {
    throw new SparseSetEncodingError(
      "sparse-set proof root must contain exactly 503 bits and one reference",
    );
  }

  const expectedRoot = slice.loadUintBig(256);
  const siblingBitmap = slice.loadUintBig(SPARSE_SET_DEPTH);
  const chain = slice.loadRef();
  const siblings = parsePackedUint256Chain(
    chain,
    sparseBitmapPopcount(siblingBitmap),
  );

  return { expectedRoot, siblingBitmap, siblings };
}

export function foldSparseSetUpdate(
  domain: number,
  key: bigint,
  proof: SparseSetUpdateProof,
): SparseSetFoldResult {
  assertDomain(domain);
  validateCompressedProof(proof);
  const coordinates = deriveSparseSetCoordinates(key);
  let oldRoot = 0n;
  let newRoot = hashSparseSetLeaf(domain, key);
  let siblingIndex = 0;

  for (let level = 0; level < SPARSE_SET_DEPTH; level += 1) {
    const hasSibling =
      ((proof.siblingBitmap >> BigInt(level)) & 1n) !== 0n;
    const sibling = hasSibling ? proof.siblings[siblingIndex] : 0n;
    if (sibling === undefined) {
      throw new SparseSetEncodingError("compressed sibling chain ended early");
    }
    if (hasSibling) siblingIndex += 1;

    if (((coordinates.path >> BigInt(level)) & 1n) === 0n) {
      oldRoot = hashSparseSetNode(domain, level, oldRoot, sibling);
      newRoot = hashSparseSetNode(domain, level, newRoot, sibling);
    } else {
      oldRoot = hashSparseSetNode(domain, level, sibling, oldRoot);
      newRoot = hashSparseSetNode(domain, level, sibling, newRoot);
    }
  }

  return { ...coordinates, oldRoot, newRoot };
}

export function verifySparseSetUpdate(opts: {
  domain: number;
  key: bigint;
  storedRoot: bigint;
  proof: SparseSetUpdateProof;
}): VerifiedSparseSetUpdate {
  assertUint("storedRoot", opts.storedRoot, UINT256_LIMIT);
  validateCompressedProof(opts.proof);
  if (opts.proof.expectedRoot !== opts.storedRoot) {
    throw new SparseSetStaleRootError(
      opts.proof.expectedRoot,
      opts.storedRoot,
    );
  }

  const folded = foldSparseSetUpdate(opts.domain, opts.key, opts.proof);
  if (folded.oldRoot !== opts.storedRoot) {
    throw new SparseSetInvalidProofError(folded.oldRoot, opts.storedRoot);
  }

  return {
    domain: opts.domain,
    key: opts.key,
    proof: opts.proof,
    ...folded,
  };
}

/** Build a deterministic vector that can be asserted by Tolk and TypeScript tests. */
export function buildSparseSetCrossVector(opts: {
  domain: number;
  key: bigint;
  siblingsByLevel: readonly bigint[];
}): SparseSetCrossVector {
  const compressed = compressSparseSetSiblings(opts.siblingsByLevel);
  const provisional: SparseSetUpdateProof = {
    expectedRoot: 0n,
    ...compressed,
  };
  const folded = foldSparseSetUpdate(opts.domain, opts.key, provisional);
  const proof: SparseSetUpdateProof = {
    expectedRoot: folded.oldRoot,
    ...compressed,
  };
  const proofCell = buildSparseSetUpdateProofCell(proof);

  return {
    domain: opts.domain,
    key: opts.key,
    proof,
    siblingsByLevel: [...opts.siblingsByLevel],
    ...folded,
    leafHash: hashSparseSetLeaf(opts.domain, opts.key),
    proofCell,
    proofCellHash: cellHashToBigInt(proofCell),
  };
}
