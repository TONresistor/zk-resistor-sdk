declare module "circom_runtime" {
  export interface WitnessCalculator {
    calculateWitness(
      input: Record<string, string | bigint | readonly (string | bigint)[]>,
      sanityCheck?: boolean,
    ): Promise<readonly unknown[]>;
  }

  export function WitnessCalculatorBuilder(
    wasm: Uint8Array | WebAssembly.Module | WebAssembly.Instance,
    sanityCheck?: boolean,
  ): Promise<WitnessCalculator>;
}
