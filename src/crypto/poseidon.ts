import { WitnessCalculatorBuilder } from "circom_runtime";

export type Poseidon2 = (a: bigint, b: bigint) => Promise<bigint>;

export function createPoseidon2(wasm: Uint8Array): Poseidon2 {
  const calculator = WitnessCalculatorBuilder(wasm);
  let queue: Promise<void> = Promise.resolve();
  return (a, b) => {
    const result = queue.then(async () => {
      const witness = await (await calculator).calculateWitness(
        { a: a.toString(), b: b.toString() },
        false,
      );
      const out = witness[1];
      if (out === undefined || out === null) {
        throw new Error("poseidon2: missing output signal at witness slot 1");
      }
      return BigInt(out.toString());
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
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
