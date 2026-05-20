import * as snarkjs from "snarkjs";

export type Poseidon2 = (a: bigint, b: bigint) => Promise<bigint>;

export function createPoseidon2(wasm: Uint8Array): Poseidon2 {
  return async (a, b) => {
    const witness: { type: "mem"; data?: Uint8Array } = { type: "mem" };
    await snarkjs.wtns.calculate(
      { a: a.toString(), b: b.toString() },
      wasm,
      witness,
    );
    const json = await snarkjs.wtns.exportJson(witness);
    const out = json[1];
    if (out === undefined) {
      throw new Error("poseidon2: missing output signal at witness slot 1");
    }
    return BigInt(out);
  };
}

export async function emptyZeros(
  poseidon2: Poseidon2,
  depth: number,
): Promise<bigint[]> {
  const z: bigint[] = [0n];
  for (let i = 1; i <= depth; i++) {
    const prev = z[i - 1] as bigint;
    z.push(await poseidon2(prev, prev));
  }
  return z;
}
