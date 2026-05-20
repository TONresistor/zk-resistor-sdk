import { bls12_381 as bls } from "@noble/curves/bls12-381.js";
import { beginCell } from "@ton/core";
import type { Cell, Builder } from "@ton/core";
import type { Groth16Proof } from "../types.js";

// @noble/curves exposes Fp2.fromBigTuple at runtime but not in its public type.
interface Fp2Element {
  c0: bigint;
  c1: bigint;
}
interface Fp2Helper {
  fromBigTuple(t: readonly [bigint, bigint]): Fp2Element;
}
const fp2: Fp2Helper = (bls.fields as unknown as { Fp2: Fp2Helper }).Fp2;

function g1ToBytes(point: readonly [string, string, string]): Uint8Array {
  const [x, y] = point;
  const p = bls.G1.Point.fromAffine({ x: BigInt(x), y: BigInt(y) });
  p.assertValidity();
  return p.toBytes(true);
}

function g2ToBytes(
  point: readonly [readonly [string, string], readonly [string, string], readonly [string, string]],
): Uint8Array {
  const [[x0, x1], [y0, y1]] = point;
  const p = bls.G2.Point.fromAffine({
    x: fp2.fromBigTuple([BigInt(x0), BigInt(x1)]),
    y: fp2.fromBigTuple([BigInt(y0), BigInt(y1)]),
  });
  p.assertValidity();
  return p.toBytes(true);
}

function chunkBuilder(
  bytes: Uint8Array,
  bytesPerChunk: 6 | 12,
  bitsPerChunk: 48 | 96,
): Builder {
  const b = beginCell();
  for (let i = 0; i < 8; i++) {
    let v = 0n;
    for (let j = 0; j < bytesPerChunk; j++) {
      const byte = bytes[i * bytesPerChunk + j];
      if (byte === undefined) {
        throw new Error("chunkBuilder: ran past the end of the compressed point bytes");
      }
      v = (v << 8n) | BigInt(byte);
    }
    b.storeUint(v, bitsPerChunk);
  }
  return b;
}

// G1 is 48 bytes compressed, G2 is 96 bytes; the verifier reads each as a slice.
export function g1ToCell(point: readonly [string, string, string]): Cell {
  return chunkBuilder(g1ToBytes(point), 6, 48).endCell();
}

export function g2ToCell(
  point: readonly [readonly [string, string], readonly [string, string], readonly [string, string]],
): Cell {
  return chunkBuilder(g2ToBytes(point), 12, 96).endCell();
}

export function buildZkProofCell(proof: Groth16Proof): Cell {
  return beginCell()
    .storeRef(g1ToCell(proof.pi_a))
    .storeRef(g2ToCell(proof.pi_b))
    .storeRef(g1ToCell(proof.pi_c))
    .endCell();
}
