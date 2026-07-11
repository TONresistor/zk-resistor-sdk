import * as Pool from "../pool.js";
import * as TonPool from "../ton-pool.js";
import { buildZkProofCell } from "../crypto/bls.js";
import type { Poseidon2 } from "../crypto/poseidon.js";
import { insertWitnessFromPath } from "../merkle.js";
import {
  buildDepositJetton,
  buildDepositPayloadCell,
  buildDepositTon,
  buildTonDepositPayloadCell,
  type BuiltMessage,
} from "../messages.js";
import { generateSecrets, serializeNote } from "../note.js";
import type { Prover } from "../prove.js";
import type { Client } from "../client.js";
import type { Note } from "../types.js";
import type { MerkleStateProvider } from "../state-provider.js";

export type DepositPhase =
  | "reading-pool"
  | "syncing-state"
  | "computing-witness"
  | "generating-proof"
  | "building-transaction";

export interface DepositOptions {
  kind: "jetton" | "ton";
  poolAddress: string;
  asset: string;
  denomination: bigint;
  userAddress: string;
  userJettonWallet?: string;
  stateProvider: MerkleStateProvider;
}

export interface DepositPrep {
  note: Note;
  noteString: string;
  poolAddress: string;
  expectedLeafIndex: number;
  expectedOldRoot: bigint;
  opts: DepositOptions;
}

export interface DepositPlan {
  note: Note;
  noteString: string;
  message: BuiltMessage;
}

export async function prepareDeposit(
  client: Client,
  opts: DepositOptions,
): Promise<DepositPrep> {
  const state =
    opts.kind === "ton"
      ? await TonPool.readState(client, opts.poolAddress)
      : await Pool.readState(client, opts.poolAddress);
  if (state.denomination !== opts.denomination) {
    throw new Error(
      `Pool denomination ${state.denomination} != expected ${opts.denomination}`,
    );
  }
  if (
    opts.kind === "jetton" &&
    (!("jettonWallet" in state) || state.jettonWallet === null)
  ) {
    throw new Error("Jetton pool is not ready: jettonWallet is not bound");
  }
  if (opts.kind === "jetton" && !opts.userJettonWallet) {
    throw new Error("userJettonWallet required for jetton deposit");
  }
  const target = opts.kind === "ton"
    ? TonPool.syncTargetFromState(opts.poolAddress, state as Awaited<
        ReturnType<typeof TonPool.readState>
      >)
    : Pool.syncTargetFromState(opts.poolAddress, state as Awaited<
        ReturnType<typeof Pool.readState>
      >);
  await opts.stateProvider.sync(target);

  const { nullifier, secret } = generateSecrets();
  const note: Note = {
    asset: opts.asset,
    denominationUnits: opts.denomination,
    leafIndex: state.nextIndex,
    nullifier,
    secret,
    poolAddress: opts.poolAddress,
    poolKind: opts.kind,
  };

  return {
    note,
    noteString: serializeNote(note),
    poolAddress: opts.poolAddress,
    expectedLeafIndex: state.nextIndex,
    expectedOldRoot: state.currentRoot,
    opts,
  };
}

export interface FinalizeDepositOptions {
  prep: DepositPrep;
  poseidon2: Poseidon2;
  insertProver: Prover;
  onProgress?: (phase: DepositPhase, message?: string) => void;
}

export async function finalizeDeposit(
  client: Client,
  finOpts: FinalizeDepositOptions,
): Promise<DepositPlan> {
  const { prep, poseidon2, insertProver } = finOpts;
  const log = finOpts.onProgress ?? (() => {});

  log("reading-pool");
  const state =
    prep.opts.kind === "ton"
      ? await TonPool.readState(client, prep.opts.poolAddress)
      : await Pool.readState(client, prep.opts.poolAddress);

  if (
    state.nextIndex !== prep.expectedLeafIndex ||
    state.currentRoot !== prep.expectedOldRoot
  ) {
    throw new Error("Pool state changed. Regenerate the secret.");
  }
  if (
    prep.opts.kind === "jetton" &&
    (!("jettonWallet" in state) || state.jettonWallet === null)
  ) {
    throw new Error("Jetton pool is not ready: jettonWallet is not bound");
  }

  log("computing-witness");
  const commitment = await poseidon2(prep.note.nullifier, prep.note.secret);
  log("syncing-state", `${state.nextIndex} deposits checkpointed`);
  const target = prep.opts.kind === "ton"
    ? TonPool.syncTargetFromState(prep.opts.poolAddress, state as Awaited<
        ReturnType<typeof TonPool.readState>
      >)
    : Pool.syncTargetFromState(prep.opts.poolAddress, state as Awaited<
        ReturnType<typeof Pool.readState>
      >);
  await prep.opts.stateProvider.sync(target);
  const [insertPath, commitmentWitness] = await Promise.all([
    prep.opts.stateProvider.insertionPath(state.nextIndex),
    prep.opts.stateProvider.sparseSetWitness("commitment", commitment),
  ]);
  const witness = await insertWitnessFromPath(poseidon2, {
    currentRoot: insertPath.currentRoot,
    path: insertPath.path,
    commitment,
    leafIndex: state.nextIndex,
  });

  if (BigInt(witness.oldRoot) !== state.currentRoot) {
    throw new Error("Pool root mismatch - pool may be misconfigured.");
  }

  log("generating-proof", "this can take 10-30 seconds");
  const { proof } = await insertProver(
    witness as unknown as Record<string, unknown>,
  );

  log("building-transaction");
  const proofCell = buildZkProofCell(proof);

  let message: BuiltMessage;
  if (prep.opts.kind === "ton") {
    const payload = buildTonDepositPayloadCell({
      fromUser: prep.opts.userAddress,
      commitment,
      newRoot: BigInt(witness.newRoot),
      proofCell,
      commitmentSetProof: commitmentWitness.proof,
    });
    message = buildDepositTon({
      poolAddress: prep.opts.poolAddress,
      fromUser: prep.opts.userAddress,
      denomination: prep.opts.denomination,
      depositPayload: payload,
    });
  } else {
    if (!prep.opts.userJettonWallet) {
      throw new Error("userJettonWallet required for jetton deposit");
    }
    const payload = buildDepositPayloadCell({
      commitment,
      newRoot: BigInt(witness.newRoot),
      proofCell,
      commitmentSetProof: commitmentWitness.proof,
    });
    message = buildDepositJetton({
      userJettonWallet: prep.opts.userJettonWallet,
      fromUser: prep.opts.userAddress,
      poolAddress: prep.opts.poolAddress,
      denomination: prep.opts.denomination,
      depositPayload: payload,
    });
  }

  return {
    note: prep.note,
    noteString: prep.noteString,
    message,
  };
}
