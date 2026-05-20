import { describe, it, expect } from "vitest";
import { buildTree, insertWitness, withdrawWitness } from "../src/merkle.js";
import type { Poseidon2 } from "../src/crypto/poseidon.js";

// Deterministic non-cryptographic stand-in: tree-shape tests depend only on
// determinism, not on the real hash.
const FIELD = 1n << 248n;
const mockPoseidon2: Poseidon2 = async (a, b) =>
  ((a * 0x12345n + b * 0x6789an + 0xdeadbeefn) ^ ((a << 7n) | (b >> 3n))) % FIELD;

describe("buildTree", () => {
  it("empty tree root = zeros[depth]", async () => {
    const tree = await buildTree(mockPoseidon2, [], 4);
    expect(tree.zeros).toHaveLength(5);
    expect(tree.root).toEqual(tree.zeros[4]);
  });

  it("single-leaf tree root depends on the leaf", async () => {
    const t1 = await buildTree(mockPoseidon2, [42n], 4);
    const t2 = await buildTree(mockPoseidon2, [43n], 4);
    expect(t1.root).not.toEqual(t2.root);
  });

  it("path siblings are zeros until other leaves are inserted", async () => {
    const tree = await buildTree(mockPoseidon2, [1n], 4);
    const path = tree.pathFor(0);
    expect(path.pathElements).toHaveLength(4);
    expect(path.pathIndices).toEqual([0, 0, 0, 0]);
    expect(path.pathElements[0]).toEqual(tree.zeros[0]);
  });

  it("pathIndices encode the binary expansion of the leaf index", async () => {
    const tree = await buildTree(mockPoseidon2, [], 4);
    const path = tree.pathFor(0b1011);
    expect(path.pathIndices).toEqual([1, 1, 0, 1]);
  });
});

describe("insertWitness", () => {
  it("oldRoot matches the pre-insert tree, newRoot reflects the insertion", async () => {
    const existing = [10n, 20n];
    const oldTree = await buildTree(mockPoseidon2, existing, 4);

    const witness = await insertWitness(mockPoseidon2, {
      existingLeaves: existing,
      commitment: 30n,
      leafIndex: 2,
      depth: 4,
    });

    expect(witness.oldRoot).toEqual(oldTree.root.toString());
    expect(witness.commitment).toEqual("30");
    expect(witness.leafIndex).toEqual("2");
    expect(witness.pathElements).toHaveLength(4);
    expect(witness.zeros).toHaveLength(4);

    const after = await buildTree(mockPoseidon2, [10n, 20n, 30n], 4);
    expect(witness.newRoot).toEqual(after.root.toString());
  });

  it("inserting into an empty tree at index 0 matches buildTree([commitment])", async () => {
    const witness = await insertWitness(mockPoseidon2, {
      existingLeaves: [],
      commitment: 99n,
      leafIndex: 0,
      depth: 4,
    });
    const direct = await buildTree(mockPoseidon2, [99n], 4);
    expect(witness.newRoot).toEqual(direct.root.toString());
  });
});

describe("withdrawWitness", () => {
  it("root matches a tree containing the commitment, recipient passes through", async () => {
    const nullifier = 7n;
    const secret = 13n;
    const commitment = await mockPoseidon2(nullifier, secret);
    const expectedNullifierHash = await mockPoseidon2(nullifier, 0n);

    const tree = await buildTree(mockPoseidon2, [commitment], 4);

    const witness = await withdrawWitness(mockPoseidon2, {
      leaves: [commitment],
      leafIndex: 0,
      nullifier,
      secret,
      recipient: 0xabcdefn,
      depth: 4,
    });

    expect(witness.root).toEqual(tree.root.toString());
    expect(witness.nullifierHash).toEqual(expectedNullifierHash.toString());
    expect(witness.recipient).toEqual(0xabcdefn.toString());
    expect(witness.nullifier).toEqual("7");
    expect(witness.secret).toEqual("13");
    expect(witness.pathElements).toHaveLength(4);
    expect(witness.pathIndices).toHaveLength(4);
  });

  it("forces the commitment at the claimed leafIndex even if leaves disagree", async () => {
    const commitment = await mockPoseidon2(1n, 2n);
    const w = await withdrawWitness(mockPoseidon2, {
      leaves: [99n, 100n],
      leafIndex: 1,
      nullifier: 1n,
      secret: 2n,
      recipient: 0n,
      depth: 4,
    });
    const expected = await buildTree(mockPoseidon2, [99n, commitment], 4);
    expect(w.root).toEqual(expected.root.toString());
  });
});
