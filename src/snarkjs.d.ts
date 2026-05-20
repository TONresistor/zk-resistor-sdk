// Minimal local typings for snarkjs (upstream ships none).
declare module "snarkjs" {
  export const groth16: {
    fullProve(
      witness: Record<string, unknown>,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(
      vk: unknown,
      publicSignals: string[],
      proof: unknown,
    ): Promise<boolean>;
  };
  export const wtns: {
    calculate(
      input: Record<string, unknown>,
      wasm: string | Uint8Array,
      witness: { type: "mem"; data?: Uint8Array },
    ): Promise<void>;
    exportJson(witness: { type: "mem"; data?: Uint8Array }): Promise<string[]>;
  };
}
