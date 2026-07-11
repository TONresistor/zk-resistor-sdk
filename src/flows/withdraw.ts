import { Address } from "@ton/core";
import * as Pool from "../pool.js";
import * as TonPool from "../ton-pool.js";
import { buildZkProofCell } from "../crypto/bls.js";
import type { Poseidon2 } from "../crypto/poseidon.js";
import { withdrawWitnessFromPath } from "../merkle.js";
import { addressToField, legacyAddressToField } from "../note.js";
import { assertAccountPoolCodeCompatible } from "../pool-code.js";
import {
  buildWithdrawMessage,
  type BuiltMessage,
} from "../messages.js";
import type { Prover } from "../prove.js";
import type { Client } from "../client.js";
import type { Note } from "../types.js";
import type { MerkleStateProvider } from "../state-provider.js";

export type WithdrawPhase =
  | "reading-pool"
  | "syncing-state"
  | "computing-witness"
  | "generating-proof"
  | "building-transaction";

export type RecipientBinding = "full-address" | "legacy-low248";

interface WithdrawBaseOptions {
  kind: "jetton" | "ton";
  note: Note;
  poolAddress: string;
  recipientAddress: string;
  queryId?: bigint;
  stateProvider: MerkleStateProvider;
  poseidon2: Poseidon2;
  withdrawProver: Prover;
  onProgress?: (phase: WithdrawPhase, message?: string) => void;
}

export type WithdrawOptions = WithdrawBaseOptions & (
  | {
    /** Defaults to the relayer-safe full-address binding. */
    recipientBinding?: "full-address";
    legacySelfBroadcastOnly?: never;
  }
  | {
    /** Compatibility only for Pools deployed with the legacy low-248 binding. */
    recipientBinding: "legacy-low248";
    /** Explicit acknowledgement that this proof must remain private. */
    legacySelfBroadcastOnly: true;
  }
);

export interface WithdrawPlan {
  message: BuiltMessage;
  nullifierHash: bigint;
  queryId: bigint;
  recipientBinding: RecipientBinding;
  relaySafe: boolean;
  /** Refreshes only the sparse proof; the Groth16 proof is reused unchanged. */
  refreshSparseProof: () => Promise<BuiltMessage>;
}

export async function buildWithdraw(
  client: Client,
  opts: WithdrawOptions,
): Promise<WithdrawPlan> {
  // Snapshot every validated input before the first await. Callers retain the
  // original options object, so reading it later would create a code-hash
  // preflight TOCTOU between proof generation and message construction.
  const kind = opts.kind;
  const note = { ...opts.note };
  const poolAddress = opts.poolAddress;
  const recipientAddress = opts.recipientAddress;
  const queryId = opts.queryId;
  const stateProvider = opts.stateProvider;
  const poseidon2 = opts.poseidon2;
  const withdrawProver = opts.withdrawProver;
  const legacySelfBroadcastOnly = opts.legacySelfBroadcastOnly;
  const log = opts.onProgress ?? (() => {});
  const recipientBinding = opts.recipientBinding ?? "full-address";
  if (
    recipientBinding !== "full-address" &&
    recipientBinding !== "legacy-low248"
  ) {
    throw new Error(`Unsupported recipient binding: ${String(recipientBinding)}`);
  }
  if (
    recipientBinding === "legacy-low248" &&
    legacySelfBroadcastOnly !== true
  ) {
    throw new Error(
      "legacy-low248 requires legacySelfBroadcastOnly: true",
    );
  }
  if (
    recipientBinding === "full-address" &&
    legacySelfBroadcastOnly !== undefined
  ) {
    throw new Error(
      "legacySelfBroadcastOnly is only valid with legacy-low248",
    );
  }

  if (typeof note.poolAddress !== "string") {
    throw new Error("Note is missing its pool address");
  }
  if (!Address.parse(note.poolAddress).equals(Address.parse(poolAddress))) {
    throw new Error("Note belongs to another pool");
  }
  if (note.poolKind !== "jetton" && note.poolKind !== "ton") {
    throw new Error("Note is missing its pool kind");
  }
  if (note.poolKind !== kind) {
    throw new Error("Note pool kind does not match withdrawal kind");
  }
  const recipient = Address.parse(recipientAddress);
  if (
    recipient.workChain !== 0 ||
    recipient.hash.every((byte) => byte === 0)
  ) {
    throw new Error("Recipient must be a non-zero basechain address");
  }

  log("reading-pool");
  const account = await client.getAccountState(poolAddress);
  assertAccountPoolCodeCompatible(account, kind, recipientBinding);
  const state =
    kind === "ton"
      ? await TonPool.readState(client, poolAddress)
      : await Pool.readState(client, poolAddress);

  if (state.denomination !== note.denominationUnits) {
    throw new Error("Note denomination != pool denomination");
  }
  if (
    kind === "jetton" &&
    (!("jettonWallet" in state) || state.jettonWallet === null)
  ) {
    throw new Error("Jetton pool is not ready: jettonWallet is not bound");
  }
  if (state.nextIndex <= note.leafIndex) {
    throw new Error(
      `Note leafIndex ${note.leafIndex} not yet on-chain (pool nextIndex=${state.nextIndex})`,
    );
  }

  log("computing-witness");
  log("syncing-state", `${state.nextIndex} deposits checkpointed`);
  const target = kind === "ton"
    ? TonPool.syncTargetFromState(poolAddress, state as Awaited<
        ReturnType<typeof TonPool.readState>
      >)
    : Pool.syncTargetFromState(poolAddress, state as Awaited<
        ReturnType<typeof Pool.readState>
      >);
  await stateProvider.sync(target);
  const membership = await stateProvider.membershipPath(note.leafIndex);
  const recipientField = recipientBinding === "legacy-low248"
    ? legacyAddressToField(recipient)
    : addressToField(recipient);
  const witness = await withdrawWitnessFromPath(poseidon2, {
    currentRoot: membership.currentRoot,
    path: membership.path,
    leafIndex: note.leafIndex,
    nullifier: note.nullifier,
    secret: note.secret,
    recipient: recipientField,
  });

  const nullifierHash = BigInt(witness.nullifierHash);
  const sparseWitness = await stateProvider.sparseSetWitness(
    "nullifier",
    nullifierHash,
  );

  log("generating-proof", "this can take 10-30 seconds");
  const { proof } = await withdrawProver(
    witness as unknown as Record<string, unknown>,
  );

  log("building-transaction");
  const proofCell = buildZkProofCell(proof);
  const buildMessage = (nullifierSetProof: typeof sparseWitness.proof, queryId?: bigint) =>
    buildWithdrawMessage({
      poolAddress,
      root: BigInt(witness.root),
      nullifierHash,
      recipient: recipientAddress,
      proofCell,
      nullifierSetProof,
      queryId,
      poolKind: kind,
    });
  const message = buildMessage(sparseWitness.proof, queryId);

  return {
    message,
    nullifierHash,
    queryId: message.queryId,
    recipientBinding,
    relaySafe: recipientBinding === "full-address",
    async refreshSparseProof() {
      const refreshTarget = kind === "ton"
        ? await TonPool.readSyncTarget(client, poolAddress)
        : await Pool.readSyncTarget(client, poolAddress);
      await stateProvider.sync(refreshTarget);
      const refreshed = await stateProvider.sparseSetWitness(
        "nullifier",
        nullifierHash,
      );
      return buildMessage(refreshed.proof, message.queryId);
    },
  };
}
