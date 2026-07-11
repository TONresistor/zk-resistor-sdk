import { beginCell } from "@ton/core";
import { describe, expect, it } from "vitest";
import { BLS12_381_R } from "../src/constants.js";
import {
  COMMITMENT_DOMAIN,
  NULLIFIER_DOMAIN,
  SPARSE_SET_DEPTH,
  SparseSetEncodingError,
  SparseSetInvalidProofError,
  SparseSetStaleRootError,
  buildPackedUint256Chain,
  buildSparseSetCrossVector,
  buildSparseSetUpdateProofCell,
  compressSparseSetSiblings,
  deriveSparseSetCoordinates,
  foldSparseSetUpdate,
  hashSparseSetLeaf,
  hashSparseSetNode,
  parsePackedUint256Chain,
  parseSparseSetUpdateProofCell,
  verifySparseSetUpdate,
  type SparseSetUpdateProof,
} from "../src/sparse-set.js";

const EMPTY_SIBLINGS = new Array<bigint>(SPARSE_SET_DEPTH).fill(0n);

describe("sparse-set hashing", () => {
  it("matches the frozen @ton/core commitment vectors", () => {
    const leaf = hashSparseSetLeaf(COMMITMENT_DOMAIN, 1n);
    expect(leaf).toBe(
      0x0436970446193375b4176eaf7525946aff80dd2227132e2182dcb1913a0697bbn,
    );
    expect(hashSparseSetNode(COMMITMENT_DOMAIN, 0, leaf, 0n)).toBe(
      0xaecfbdf470bd3f6f05453be4caa1000be993690168bcbcec49bbd8acb384ea04n,
    );

    const vector = buildSparseSetCrossVector({
      domain: COMMITMENT_DOMAIN,
      key: 0x0102n,
      siblingsByLevel: EMPTY_SIBLINGS,
    });
    expect(vector.leafHash).toBe(
      0xf69ec039a082ce866fc04632541f19f4fc7373cb94dff365c0fa05ed19fae813n,
    );
    expect(vector.newRoot).toBe(
      0x5af50a31a5a143de454df246051534fad6fbc551d94121157b34d6331fc5ebcdn,
    );
    expect(vector.oldRoot).toBe(0n);
  });

  it("domain-separates commitment and nullifier sets", () => {
    expect(hashSparseSetLeaf(COMMITMENT_DOMAIN, 7n)).not.toBe(
      hashSparseSetLeaf(NULLIFIER_DOMAIN, 7n),
    );
  });

  it("uses the low byte as bucket and the remaining 247 bits as path", () => {
    expect(deriveSparseSetCoordinates(0x0102n)).toEqual({
      bucketId: 2,
      path: 1n,
    });
    expect(deriveSparseSetCoordinates(BLS12_381_R - 1n).path).toBeLessThan(
      1n << 247n,
    );
    expect(() => deriveSparseSetCoordinates(-1n)).toThrow(RangeError);
    expect(() => deriveSparseSetCoordinates(BLS12_381_R)).toThrow(RangeError);
    expect(() => deriveSparseSetCoordinates(1n << 255n)).toThrow(RangeError);
  });

  it("keeps the all-zero subtree as the zero sentinel", () => {
    expect(hashSparseSetNode(COMMITMENT_DOMAIN, 0, 0n, 0n)).toBe(0n);
  });
});

describe("sparse-set canonical proof codec", () => {
  it.each([0, 1, 2, 3, 4, 247])(
    "round-trips a canonical %i-sibling chain",
    (count) => {
      const values = Array.from({ length: count }, (_, i) => BigInt(i + 1));
      const chain = buildPackedUint256Chain(values);
      expect(parsePackedUint256Chain(chain, count)).toEqual(values);

      let current = chain;
      let remaining = count;
      let cells = 1;
      while (remaining > 3) {
        const slice = current.beginParse();
        expect(slice.remainingBits).toBe(768);
        expect(slice.remainingRefs).toBe(1);
        current = slice.loadRef();
        remaining -= 3;
        cells += 1;
      }
      expect(cells).toBe(Math.max(1, Math.ceil(count / 3)));
      expect(current.beginParse().remainingBits).toBe(remaining * 256);
      expect(current.beginParse().remainingRefs).toBe(0);
    },
  );

  it("round-trips a proof root with bitmap and packed siblings", () => {
    const siblingsByLevel = [...EMPTY_SIBLINGS];
    siblingsByLevel[0] = 11n;
    siblingsByLevel[17] = 22n;
    siblingsByLevel[246] = 33n;
    const compressed = compressSparseSetSiblings(siblingsByLevel);
    const proof: SparseSetUpdateProof = {
      expectedRoot: 44n,
      ...compressed,
    };
    const cell = buildSparseSetUpdateProofCell(proof);
    expect(cell.bits.length).toBe(503);
    expect(cell.refs).toHaveLength(1);
    expect(parseSparseSetUpdateProofCell(cell)).toEqual(proof);
  });

  it("rejects zero siblings and non-canonical chunk shapes", () => {
    expect(() =>
      buildSparseSetUpdateProofCell({
        expectedRoot: 0n,
        siblingBitmap: 1n,
        siblings: [0n],
      }),
    ).toThrow(SparseSetEncodingError);

    const malformedChain = beginCell()
      .storeUint(1n, 256)
      .storeUint(2n, 256)
      .storeRef(beginCell().storeUint(3n, 256).storeUint(4n, 256))
      .endCell();
    expect(() => parsePackedUint256Chain(malformedChain, 4)).toThrow(
      SparseSetEncodingError,
    );

    const trailingRoot = beginCell()
      .storeUint(0n, 256)
      .storeUint(0n, SPARSE_SET_DEPTH)
      .storeBit(0)
      .storeRef(beginCell().endCell())
      .endCell();
    expect(() => parseSparseSetUpdateProofCell(trailingRoot)).toThrow(
      SparseSetEncodingError,
    );
  });
});

describe("sparse-set updates", () => {
  it("distinguishes stale roots from invalid non-membership proofs", () => {
    const vector = buildSparseSetCrossVector({
      domain: COMMITMENT_DOMAIN,
      key: 1n,
      siblingsByLevel: EMPTY_SIBLINGS,
    });
    expect(
      verifySparseSetUpdate({
        domain: COMMITMENT_DOMAIN,
        key: 1n,
        storedRoot: 0n,
        proof: vector.proof,
      }).newRoot,
    ).toBe(vector.newRoot);

    expect(() =>
      verifySparseSetUpdate({
        domain: COMMITMENT_DOMAIN,
        key: 1n,
        storedRoot: vector.newRoot,
        proof: vector.proof,
      }),
    ).toThrow(SparseSetStaleRootError);

    expect(() =>
      verifySparseSetUpdate({
        domain: COMMITMENT_DOMAIN,
        key: 1n,
        storedRoot: vector.newRoot,
        proof: { ...vector.proof, expectedRoot: vector.newRoot },
      }),
    ).toThrow(SparseSetInvalidProofError);
  });

  it("matches the frozen same-bucket insertion sequence", () => {
    const levels = Array.from(
      { length: SPARSE_SET_DEPTH + 1 },
      () => new Map<bigint, bigint>(),
    );
    const expectedRoots = [
      0xbbe0be78eb65a39b1a7b13922381e089c0b14c1c8d2ef1db3dd92010a97e97acn,
      0xeba4e2746788daf95de5297d1b6eddef5c3e43995f7e79ea85dce665a1f6d888n,
      0x7732af1efa94e128ae0ed84437f9ef53f45330b868589b9bf5d3d557b63c7ddan,
    ];
    let storedRoot = 0n;

    for (const [insertIndex, key] of [1n, 257n, 513n].entries()) {
      const { path } = deriveSparseSetCoordinates(key);
      const siblingsByLevel = new Array<bigint>(SPARSE_SET_DEPTH).fill(0n);
      for (let level = 0; level < SPARSE_SET_DEPTH; level += 1) {
        siblingsByLevel[level] =
          levels[level]?.get((path >> BigInt(level)) ^ 1n) ?? 0n;
      }
      const vector = buildSparseSetCrossVector({
        domain: COMMITMENT_DOMAIN,
        key,
        siblingsByLevel,
      });
      expect(vector.oldRoot).toBe(storedRoot);
      expect(vector.newRoot).toBe(expectedRoots[insertIndex]);
      expect(
        foldSparseSetUpdate(COMMITMENT_DOMAIN, key, vector.proof).newRoot,
      ).toBe(vector.newRoot);

      let node = vector.leafHash;
      levels[0]?.set(path, node);
      for (let level = 0; level < SPARSE_SET_DEPTH; level += 1) {
        const nodeIndex = path >> BigInt(level);
        const sibling = siblingsByLevel[level] as bigint;
        node =
          (nodeIndex & 1n) === 0n
            ? hashSparseSetNode(COMMITMENT_DOMAIN, level, node, sibling)
            : hashSparseSetNode(COMMITMENT_DOMAIN, level, sibling, node);
        levels[level + 1]?.set(nodeIndex >> 1n, node);
      }
      storedRoot = vector.newRoot;
    }
  });
});
