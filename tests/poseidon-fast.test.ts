import { describe, expect, it } from "vitest";
import { EMPTY_TREE_ROOT } from "../src/constants.js";
import {
  createFastPoseidon2,
  POSEIDON_BLS12_381_FIELD,
  poseidon2Fast,
} from "../src/crypto/poseidon-fast.js";
import { emptyZeros } from "../src/crypto/poseidon.js";

const WASM_CROSS_VECTORS = [
  [0n, 0n, 51576823595707970152643159819788304363803754756066229172775779360774743019614n],
  [1n, 2n, 28821147804331559602169231704816259064962739503761913593647409715501647586810n],
  [7n, 13n, 15079774324338247548721043031672080896959934434070561368088927325530240337977n],
  [123456789n, 987654321n, 7259761822356338919011747483582999411414453055692031385862656213622249484940n],
] as const;

describe("pure JavaScript Poseidon BLS12-381", () => {
  it("matches frozen hasher.wasm cross-vectors", () => {
    for (const [a, b, expected] of WASM_CROSS_VECTORS) {
      expect(poseidon2Fast(a, b)).toBe(expected);
    }
  });

  it("reaches the deployed depth-20 empty root", async () => {
    const zeros = await emptyZeros(createFastPoseidon2(), 20);
    expect(zeros[20]).toBe(EMPTY_TREE_ROOT);
  });

  it("rejects values outside the circuit scalar field", () => {
    expect(() => poseidon2Fast(-1n, 0n)).toThrow(/scalar field/);
    expect(() => poseidon2Fast(POSEIDON_BLS12_381_FIELD, 0n))
      .toThrow(/scalar field/);
  });
});
