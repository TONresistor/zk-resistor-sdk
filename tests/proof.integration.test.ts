import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import {
  addressToField,
  buildZkProofCell,
  createPoseidon2,
  createSnarkjsProver,
  EMPTY_TREE_ROOT,
  generateSecrets,
  insertWitness,
  withdrawWitness,
} from "../src/index.js";

// Real-circuit proof pipeline. Gated on ZKR_CIRCUIT_DIR (the circuits build/
// directory); skips cleanly when the multi-MB artifacts are absent, e.g. in CI.
const DIR = process.env.ZKR_CIRCUIT_DIR;
const ready =
  !!DIR &&
  existsSync(`${DIR}/insert_final.zkey`) &&
  existsSync(`${DIR}/withdraw_final.zkey`) &&
  existsSync(`${DIR}/hasher_js/hasher.wasm`) &&
  existsSync(`${DIR}/insert_vk.json`) &&
  existsSync(`${DIR}/withdraw_vk.json`);

function poseidon() {
  return createPoseidon2(
    new Uint8Array(readFileSync(`${DIR}/hasher_js/hasher.wasm`)),
  );
}

describe.skipIf(!ready)("proof pipeline (real circuits)", () => {
  it("insert: SDK witness produces a valid Groth16 proof", async () => {
    const poseidon2 = poseidon();
    const note = generateSecrets();
    const commitment = await poseidon2(note.nullifier, note.secret);

    const witness = await insertWitness(poseidon2, {
      existingLeaves: [],
      commitment,
      leafIndex: 0,
    });
    expect(BigInt(witness.oldRoot)).toBe(EMPTY_TREE_ROOT);

    const prove = createSnarkjsProver({
      wasm: `${DIR}/insert_js/insert.wasm`,
      zkey: `${DIR}/insert_final.zkey`,
    });
    const { proof, publicSignals } = await prove(
      witness as unknown as Record<string, unknown>,
    );

    const vk = JSON.parse(readFileSync(`${DIR}/insert_vk.json`, "utf8"));
    expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);

    const cell = buildZkProofCell(proof);
    expect(cell.refs.length).toBe(3);
    expect(cell.bits.length).toBe(0);
  }, 90_000);

  it("withdraw: SDK witness produces a valid Groth16 proof", async () => {
    const poseidon2 = poseidon();
    const note = generateSecrets();
    const commitment = await poseidon2(note.nullifier, note.secret);

    const witness = await withdrawWitness(poseidon2, {
      leaves: [commitment],
      leafIndex: 0,
      nullifier: note.nullifier,
      secret: note.secret,
      recipient: addressToField(
        "EQB8PZ-Cp6UzydbLvjukx1OQL3LmqeYV-tJ3qVMw_mNYgqow",
      ),
    });

    const prove = createSnarkjsProver({
      wasm: `${DIR}/withdraw_js/withdraw.wasm`,
      zkey: `${DIR}/withdraw_final.zkey`,
    });
    const { proof, publicSignals } = await prove(
      witness as unknown as Record<string, unknown>,
    );

    const vk = JSON.parse(readFileSync(`${DIR}/withdraw_vk.json`, "utf8"));
    expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);
  }, 90_000);
});
