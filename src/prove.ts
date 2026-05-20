import * as snarkjs from "snarkjs";
import type { Groth16Proof } from "./types.js";

export interface ProverInputs {
  wasm: string | Uint8Array;
  zkey: string | Uint8Array;
}

export type Prover = (
  witness: Record<string, unknown>,
) => Promise<{ proof: Groth16Proof; publicSignals: string[] }>;

export function createSnarkjsProver(artifacts: ProverInputs): Prover {
  return async (witness) => {
    const r = await snarkjs.groth16.fullProve(
      witness,
      artifacts.wasm,
      artifacts.zkey,
    );
    return { proof: r.proof as Groth16Proof, publicSignals: r.publicSignals };
  };
}
