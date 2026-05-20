import { Address } from "@ton/core";
import * as Pool from "../pool.js";
import * as TonPool from "../ton-pool.js";
import { buildZkProofCell } from "../crypto/bls.js";
import type { Poseidon2 } from "../crypto/poseidon.js";
import { withdrawWitness } from "../merkle.js";
import { addressToField } from "../note.js";
import { buildWithdrawMessage, type BuiltMessage } from "../messages.js";
import type { Prover } from "../prove.js";
import type { Client } from "../client.js";
import type { Note } from "../types.js";

export type WithdrawPhase =
  | "reading-pool"
  | "rebuilding-tree"
  | "computing-witness"
  | "generating-proof"
  | "building-transaction";

export interface WithdrawOptions {
  kind: "jetton" | "ton";
  note: Note;
  poolAddress: string;
  recipientAddress: string;
  poseidon2: Poseidon2;
  withdrawProver: Prover;
  onProgress?: (phase: WithdrawPhase, message?: string) => void;
}

export interface WithdrawPlan {
  message: BuiltMessage;
  nullifierHash: bigint;
}

export async function buildWithdraw(
  client: Client,
  opts: WithdrawOptions,
): Promise<WithdrawPlan> {
  const log = opts.onProgress ?? (() => {});

  log("reading-pool");
  const state =
    opts.kind === "ton"
      ? await TonPool.readState(client, opts.poolAddress)
      : await Pool.readState(client, opts.poolAddress);

  if (state.denomination !== opts.note.denominationUnits) {
    throw new Error("Note denomination != pool denomination");
  }
  if (state.nextIndex <= opts.note.leafIndex) {
    throw new Error(
      `Note leafIndex ${opts.note.leafIndex} not yet on-chain (pool nextIndex=${state.nextIndex})`,
    );
  }

  log("rebuilding-tree", `${state.nextIndex} existing deposits`);
  const events = await Pool.fetchDepositCommitments(client, opts.poolAddress);
  const leaves: bigint[] = [];
  for (const e of events) leaves[e.leafIndex] = e.commitment;

  log("computing-witness");
  const recipientField = addressToField(Address.parse(opts.recipientAddress));
  const witness = await withdrawWitness(opts.poseidon2, {
    leaves,
    leafIndex: opts.note.leafIndex,
    nullifier: opts.note.nullifier,
    secret: opts.note.secret,
    recipient: recipientField,
  });

  log("generating-proof", "this can take 10-30 seconds");
  const { proof } = await opts.withdrawProver(
    witness as unknown as Record<string, unknown>,
  );

  log("building-transaction");
  const proofCell = buildZkProofCell(proof);
  const message = buildWithdrawMessage({
    poolAddress: opts.poolAddress,
    root: BigInt(witness.root),
    nullifierHash: BigInt(witness.nullifierHash),
    recipient: opts.recipientAddress,
    proofCell,
  });

  return {
    message,
    nullifierHash: BigInt(witness.nullifierHash),
  };
}
