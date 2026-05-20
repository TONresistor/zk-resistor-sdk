import { describe, it, expect } from "vitest";
import { bls12_381 as bls } from "@noble/curves/bls12-381.js";
import { buildZkProofCell, g1ToCell, g2ToCell } from "../src/crypto/bls.js";
import type { Groth16Proof } from "../src/types.js";

function g1Generator(): readonly [string, string, string] {
  const gen = bls.G1.Point.BASE.toAffine();
  return [gen.x.toString(), gen.y.toString(), "1"];
}

function g2Generator(): readonly [
  readonly [string, string],
  readonly [string, string],
  readonly [string, string],
] {
  const gen = bls.G2.Point.BASE.toAffine();
  return [
    [gen.x.c0.toString(), gen.x.c1.toString()],
    [gen.y.c0.toString(), gen.y.c1.toString()],
    ["1", "0"],
  ];
}

describe("g1ToCell", () => {
  it("encodes the G1 generator as 8 x 48-bit chunks (384 bits)", () => {
    const cell = g1ToCell(g1Generator());
    const cs = cell.beginParse();
    expect(cs.remainingBits).toBe(8 * 48);
    expect(cs.remainingRefs).toBe(0);
    for (let i = 0; i < 8; i++) {
      expect(cs.loadUintBig(48)).toBeLessThan(1n << 48n);
    }
  });

  it("two distinct points produce distinct encodings", () => {
    const g = g1Generator();
    const c1 = g1ToCell(g);
    const c2 = g1ToCell(g);
    expect(c1.toBoc().toString("hex")).toEqual(c2.toBoc().toString("hex"));

    const doubled = bls.G1.Point.BASE.double().toAffine();
    const cDouble = g1ToCell([doubled.x.toString(), doubled.y.toString(), "1"]);
    expect(cDouble.toBoc().toString("hex")).not.toEqual(
      c1.toBoc().toString("hex"),
    );
  });
});

describe("g2ToCell", () => {
  it("encodes the G2 generator as 8 x 96-bit chunks (768 bits)", () => {
    const cell = g2ToCell(g2Generator());
    const cs = cell.beginParse();
    expect(cs.remainingBits).toBe(8 * 96);
    expect(cs.remainingRefs).toBe(0);
    for (let i = 0; i < 8; i++) {
      expect(cs.loadUintBig(96)).toBeLessThan(1n << 96n);
    }
  });
});

describe("buildZkProofCell", () => {
  it("produces a cell with exactly 3 refs and 0 bits", () => {
    const proof: Groth16Proof = {
      pi_a: g1Generator() as [string, string, string],
      pi_b: g2Generator() as [
        [string, string],
        [string, string],
        [string, string],
      ],
      pi_c: g1Generator() as [string, string, string],
      protocol: "groth16",
      curve: "bls12381",
    };
    const cell = buildZkProofCell(proof);
    const cs = cell.beginParse();
    expect(cs.remainingBits).toBe(0);
    expect(cs.remainingRefs).toBe(3);

    const a = cs.loadRef().beginParse();
    const b = cs.loadRef().beginParse();
    const c = cs.loadRef().beginParse();
    expect(a.remainingBits).toBe(8 * 48);
    expect(b.remainingBits).toBe(8 * 96);
    expect(c.remainingBits).toBe(8 * 48);
  });

  it("rejects an invalid point", () => {
    const bogus: Groth16Proof = {
      pi_a: ["1", "1", "1"],
      pi_b: g2Generator() as [
        [string, string],
        [string, string],
        [string, string],
      ],
      pi_c: g1Generator() as [string, string, string],
      protocol: "groth16",
      curve: "bls12381",
    };
    expect(() => buildZkProofCell(bogus)).toThrow();
  });
});
