import { TREE_DEPTH } from "./constants.js";
import type { Poseidon2 } from "./crypto/poseidon.js";
import { emptyZeros } from "./crypto/poseidon.js";
import type { InsertWitness, MerklePath, WithdrawWitness } from "./types.js";

export interface MerkleTree {
  root: bigint;
  zeros: bigint[];
  pathFor: (leafIndex: number) => MerklePath;
}

export async function buildTree(
  poseidon2: Poseidon2,
  leaves: readonly bigint[],
  depth: number = TREE_DEPTH,
): Promise<MerkleTree> {
  const zeros = await emptyZeros(poseidon2, depth);

  const layers: Map<number, bigint>[] = [new Map()];
  const layer0 = layers[0] as Map<number, bigint>;
  for (let i = 0; i < leaves.length; i++) {
    const v = leaves[i];
    if (v !== undefined) layer0.set(i, v);
  }

  for (let level = 0; level < depth; level++) {
    const cur = layers[level] as Map<number, bigint>;
    const z = zeros[level] as bigint;
    const next = new Map<number, bigint>();
    const parents = new Set<number>();
    for (const idx of cur.keys()) parents.add(idx >> 1);
    for (const parent of parents) {
      const li = parent * 2;
      const ri = parent * 2 + 1;
      const left = cur.get(li) ?? z;
      const right = cur.get(ri) ?? z;
      next.set(parent, await poseidon2(left, right));
    }
    layers.push(next);
  }

  function getNode(level: number, idx: number): bigint {
    return (layers[level] as Map<number, bigint>).get(idx) ?? (zeros[level] as bigint);
  }

  return {
    root: getNode(depth, 0),
    zeros,
    pathFor(leafIndex: number): MerklePath {
      const pathElements: bigint[] = [];
      const pathIndices: number[] = [];
      let idx = leafIndex;
      for (let level = 0; level < depth; level++) {
        const sibling = idx ^ 1;
        pathElements.push(getNode(level, sibling));
        pathIndices.push(idx & 1);
        idx >>= 1;
      }
      return { pathElements, pathIndices };
    },
  };
}

export async function insertWitness(
  poseidon2: Poseidon2,
  opts: {
    existingLeaves: readonly bigint[];
    commitment: bigint;
    leafIndex: number;
    depth?: number;
  },
): Promise<InsertWitness> {
  const depth = opts.depth ?? TREE_DEPTH;

  const oldTree = await buildTree(poseidon2, opts.existingLeaves, depth);
  const path = oldTree.pathFor(opts.leafIndex);

  const newLeaves = [...opts.existingLeaves];
  newLeaves[opts.leafIndex] = opts.commitment;
  const newTree = await buildTree(poseidon2, newLeaves, depth);

  return {
    oldRoot: oldTree.root.toString(),
    newRoot: newTree.root.toString(),
    commitment: opts.commitment.toString(),
    leafIndex: BigInt(opts.leafIndex).toString(),
    pathElements: path.pathElements.map((x) => x.toString()),
    zeros: oldTree.zeros.slice(0, depth).map((x) => x.toString()),
  };
}

async function foldPath(
  poseidon2: Poseidon2,
  leaf: bigint,
  path: MerklePath,
): Promise<bigint> {
  let node = leaf;
  for (let level = 0; level < path.pathElements.length; level += 1) {
    const sibling = path.pathElements[level];
    const direction = path.pathIndices[level];
    if (sibling === undefined || (direction !== 0 && direction !== 1)) {
      throw new RangeError(`invalid Merkle path at level ${level}`);
    }
    node = direction === 0
      ? await poseidon2(node, sibling)
      : await poseidon2(sibling, node);
  }
  return node;
}

export async function insertWitnessFromPath(
  poseidon2: Poseidon2,
  opts: {
    currentRoot: bigint;
    commitment: bigint;
    leafIndex: number;
    path: MerklePath;
    depth?: number;
  },
): Promise<InsertWitness> {
  const depth = opts.depth ?? TREE_DEPTH;
  if (
    opts.path.pathElements.length !== depth ||
    opts.path.pathIndices.length !== depth
  ) {
    throw new RangeError(`insertion path must contain exactly ${depth} levels`);
  }
  const zeros = await emptyZeros(poseidon2, depth);
  const oldRoot = await foldPath(poseidon2, zeros[0] as bigint, opts.path);
  if (oldRoot !== opts.currentRoot) {
    throw new Error("insertion path does not match the current pool root");
  }
  const newRoot = await foldPath(poseidon2, opts.commitment, opts.path);
  return {
    oldRoot: oldRoot.toString(),
    newRoot: newRoot.toString(),
    commitment: opts.commitment.toString(),
    leafIndex: opts.leafIndex.toString(),
    pathElements: opts.path.pathElements.map((value) => value.toString()),
    zeros: zeros.slice(0, depth).map((value) => value.toString()),
  };
}

export async function withdrawWitness(
  poseidon2: Poseidon2,
  opts: {
    leaves: readonly bigint[];
    leafIndex: number;
    nullifier: bigint;
    secret: bigint;
    recipient: bigint;
    depth?: number;
  },
): Promise<WithdrawWitness> {
  const depth = opts.depth ?? TREE_DEPTH;
  const commitment = await poseidon2(opts.nullifier, opts.secret);
  const nullifierHash = await poseidon2(opts.nullifier, 0n);

  const leaves = [...opts.leaves];
  leaves[opts.leafIndex] = commitment;
  const tree = await buildTree(poseidon2, leaves, depth);
  const path = tree.pathFor(opts.leafIndex);

  return {
    root: tree.root.toString(),
    nullifierHash: nullifierHash.toString(),
    recipient: opts.recipient.toString(),
    nullifier: opts.nullifier.toString(),
    secret: opts.secret.toString(),
    pathElements: path.pathElements.map((x) => x.toString()),
    pathIndices: path.pathIndices.map((x) => x.toString()),
  };
}

export async function withdrawWitnessFromPath(
  poseidon2: Poseidon2,
  opts: {
    currentRoot: bigint;
    leafIndex: number;
    path: MerklePath;
    nullifier: bigint;
    secret: bigint;
    recipient: bigint;
    depth?: number;
  },
): Promise<WithdrawWitness> {
  const depth = opts.depth ?? TREE_DEPTH;
  if (
    opts.path.pathElements.length !== depth ||
    opts.path.pathIndices.length !== depth
  ) {
    throw new RangeError(`membership path must contain exactly ${depth} levels`);
  }
  const commitment = await poseidon2(opts.nullifier, opts.secret);
  const root = await foldPath(poseidon2, commitment, opts.path);
  if (root !== opts.currentRoot) {
    throw new Error("membership path does not match the current pool root");
  }
  const nullifierHash = await poseidon2(opts.nullifier, 0n);
  return {
    root: root.toString(),
    nullifierHash: nullifierHash.toString(),
    recipient: opts.recipient.toString(),
    nullifier: opts.nullifier.toString(),
    secret: opts.secret.toString(),
    pathElements: opts.path.pathElements.map((value) => value.toString()),
    pathIndices: opts.path.pathIndices.map((value) => value.toString()),
  };
}
