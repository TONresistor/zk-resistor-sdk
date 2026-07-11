import { bls12_381 as bls } from "@noble/curves/bls12-381.js";
import { Address, beginCell } from "@ton/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  OP_DEPOSIT,
  OP_WITHDRAW,
} from "../src/constants.js";
import type { Poseidon2 } from "../src/crypto/poseidon.js";
import { finalizeDeposit, prepareDeposit } from "../src/flows/deposit.js";
import {
  buildWithdraw,
  type WithdrawOptions,
} from "../src/flows/withdraw.js";
import { buildTree } from "../src/merkle.js";
import { addressToField, legacyAddressToField } from "../src/note.js";
import { sparseSetDomain } from "../src/state-provider.js";
import { deriveSparseSetCoordinates } from "../src/sparse-set.js";
import type {
  MerkleStateCheckpoint,
  MerkleStateProvider,
  MerkleStateSyncTarget,
  SparseSetId,
} from "../src/state-provider.js";
import type { Client } from "../src/client.js";
import type { Groth16Proof, Note } from "../src/types.js";
import {
  LEGACY_TON_POOL_CODE_BOC,
  SECURE_POOL_CODE_BOC,
  SECURE_TON_POOL_CODE_BOC,
} from "./fixtures/pool-code-bocs.js";

const FIELD = 1n << 248n;
const poseidon2: Poseidon2 = async (a, b) =>
  ((a * 0x12345n + b * 0x6789an + 0xdeadbeefn) ^ ((a << 7n) | (b >> 3n))) % FIELD;
const POOL = Address.parseRaw(`0:${"11".repeat(32)}`).toString();
const FACTORY = Address.parseRaw(`0:${"22".repeat(32)}`);
const JETTON_MASTER = Address.parseRaw(`0:${"44".repeat(32)}`);
const USER = Address.parseRaw(`0:${"33".repeat(32)}`).toString();

function proof(): Groth16Proof {
  const g1 = bls.G1.Point.BASE.toAffine();
  const g2 = bls.G2.Point.BASE.toAffine();
  return {
    pi_a: [g1.x.toString(), g1.y.toString(), "1"],
    pi_b: [
      [g2.x.c0.toString(), g2.x.c1.toString()],
      [g2.y.c0.toString(), g2.y.c1.toString()],
      ["1", "0"],
    ],
    pi_c: [g1.x.toString(), g1.y.toString(), "1"],
    protocol: "groth16",
    curve: "bls12381",
  };
}

function tonPoolData(nextIndex: number, currentRoot: bigint): string {
  const identity = beginCell()
    .storeAddress(FACTORY)
    .storeCoins(10_000_000_000n)
    .endCell();
  const merkle = beginCell()
    .storeUint(nextIndex, 32)
    .storeUint(currentRoot, 256)
    .endCell();
  return beginCell()
    .storeRef(identity)
    .storeCoins(1_000_000_000n)
    .storeCoins(BigInt(nextIndex) * 10_000_000_000n)
    .storeRef(merkle)
    .endCell()
    .toBoc()
    .toString("base64");
}

function clientFor(
  data: string,
  code: string | null = SECURE_TON_POOL_CODE_BOC,
): Client {
  return {
    async getAccountState() {
      return { status: "active", data, ...(code === null ? {} : { code }) };
    },
    async runMethod(_address, method) {
      if (method === "withdrawalCount") return { exit_code: 0, stack: ["0"] };
      throw new Error(`unexpected getter ${method}`);
    },
    async getTransactions() { throw new Error("legacy full scan must not run"); },
  };
}

function jettonPoolData(
  nextIndex: number,
  currentRoot: bigint,
  jettonWallet: Address | null = Address.parseRaw(`0:${"55".repeat(32)}`),
): string {
  const identity = beginCell()
    .storeAddress(JETTON_MASTER)
    .storeAddress(FACTORY)
    .storeCoins(10_000_000_000n)
    .endCell();
  const merkle = beginCell()
    .storeUint(nextIndex, 32)
    .storeUint(currentRoot, 256)
    .endCell();
  return beginCell()
    .storeRef(identity)
    .storeAddress(jettonWallet)
    .storeCoins(1_000_000_000n)
    .storeRef(merkle)
    .storeUint(0, 32)
    .endCell()
    .toBoc()
    .toString("base64");
}

function jettonClientFor(
  data: string,
  code: string | null = SECURE_POOL_CODE_BOC,
): Client {
  return {
    async getAccountState() {
      return { status: "active", data, ...(code === null ? {} : { code }) };
    },
    async runMethod(_address, method) {
      if (method === "withdrawalCount") {
        return { exit_code: 0, stack: ["0"] };
      }
      throw new Error(`unexpected getter ${method}`);
    },
    async getTransactions() { throw new Error("legacy full scan must not run"); },
  };
}

function checkpoint(target: MerkleStateSyncTarget): MerkleStateCheckpoint {
  return {
    schemaVersion: 1,
    poolAddress: target.poolAddress,
    position: { blockSeqno: 1, transactionLt: 1n, eventIndex: 0 },
    nextIndex: target.nextIndex,
    withdrawalCount: target.withdrawalCount,
    currentRoot: target.currentRoot,
    commitmentSeenRoots: new Array<bigint>(256).fill(0n),
    nullifierSpentRoots: new Array<bigint>(256).fill(0n),
  };
}

function providerFor(tree: Awaited<ReturnType<typeof buildTree>>, nextIndex: number) {
  const sync = vi.fn(async (target: MerkleStateSyncTarget) => checkpoint(target));
  const sparseSetWitness = vi.fn(async (setId: SparseSetId, key: bigint) => {
    const { bucketId } = deriveSparseSetCoordinates(key);
    return {
      setId,
      domain: sparseSetDomain(setId),
      key,
      bucketId,
      storedRoot: 0n,
      proof: { expectedRoot: 0n, siblingBitmap: 0n, siblings: [] },
    };
  });
  const provider = {
    privacyMode: "local",
    sync,
    async checkpoint() { return checkpoint({
      poolAddress: POOL,
      nextIndex,
      withdrawalCount: 0,
      currentRoot: tree.root,
    }); },
    async insertionPath(index: number) {
      return { nextIndex: index, currentRoot: tree.root, path: tree.pathFor(index) };
    },
    async membershipPath(index: number) {
      return { leafIndex: index, currentRoot: tree.root, path: tree.pathFor(index) };
    },
    sparseSetWitness,
  } satisfies MerkleStateProvider;
  return { provider, sync, sparseSetWitness };
}

describe("provider-backed flows", () => {
  it("refuses a Jetton deposit before wallet binding is ready", async () => {
    const tree = await buildTree(poseidon2, []);
    const { provider, sync } = providerFor(tree, 0);
    await expect(prepareDeposit(
      jettonClientFor(jettonPoolData(0, tree.root, null)),
      {
        kind: "jetton",
        poolAddress: POOL,
        asset: "KITO",
        denomination: 10_000_000_000n,
        userAddress: USER,
        userJettonWallet: USER,
        stateProvider: provider,
      },
    )).rejects.toThrow(/not ready/);
    expect(sync).not.toHaveBeenCalled();
  });

  it("builds a TON deposit without fetching full history", async () => {
    const tree = await buildTree(poseidon2, []);
    const { provider, sync } = providerFor(tree, 0);
    const client = clientFor(tonPoolData(0, tree.root));
    const prep = await prepareDeposit(client, {
      kind: "ton",
      poolAddress: POOL,
      asset: "TON",
      denomination: 10_000_000_000n,
      userAddress: USER,
      stateProvider: provider,
    });
    const prover = vi.fn(async () => ({ proof: proof(), publicSignals: [] }));
    const plan = await finalizeDeposit(client, {
      prep,
      poseidon2,
      insertProver: prover,
    });
    const slice = plan.message.payload.beginParse();
    expect(slice.loadUint(32)).toBe(OP_DEPOSIT);
    expect(slice.remainingRefs).toBe(2);
    expect(plan.message.queryId).toBe(
      plan.message.payload.beginParse().skip(32).loadUintBig(64),
    );
    expect(prep.note.poolAddress).toBe(POOL);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(prover).toHaveBeenCalledTimes(1);
  });

  it("refreshes only the sparse withdrawal proof and exposes no recovery API", async () => {
    const note: Note = {
      asset: "TON",
      denominationUnits: 10_000_000_000n,
      leafIndex: 0,
      nullifier: 7n,
      secret: 13n,
      poolAddress: POOL,
      poolKind: "ton",
    };
    const commitment = await poseidon2(note.nullifier, note.secret);
    const tree = await buildTree(poseidon2, [commitment]);
    const { provider, sparseSetWitness } = providerFor(tree, 1);
    const prover = vi.fn(async () => ({ proof: proof(), publicSignals: [] }));
    const plan = await buildWithdraw(clientFor(tonPoolData(1, tree.root)), {
      kind: "ton",
      note,
      poolAddress: POOL,
      recipientAddress: USER,
      queryId: 99n,
      stateProvider: provider,
      poseidon2,
      withdrawProver: prover,
    });
    expect(plan.message.payload.beginParse().loadUint(32)).toBe(OP_WITHDRAW);
    expect(plan.message.payload.refs).toHaveLength(2);
    await plan.refreshSparseProof();
    expect(prover).toHaveBeenCalledTimes(1);
    expect(sparseSetWitness).toHaveBeenCalledTimes(2);
    expect(plan).not.toHaveProperty("recoveryDraft");
    expect(plan).not.toHaveProperty("buildRequestRetry");

    const jettonNote = { ...note, poolKind: "jetton" as const };
    const jettonPlan = await buildWithdraw(jettonClientFor(jettonPoolData(1, tree.root)), {
      kind: "jetton",
      note: jettonNote,
      poolAddress: POOL,
      recipientAddress: USER,
      queryId: 100n,
      stateProvider: provider,
      poseidon2,
      withdrawProver: prover,
    });
    expect(jettonPlan.queryId).toBe(100n);
    expect(jettonPlan).not.toHaveProperty("recoveryDraft");
    expect(jettonPlan).not.toHaveProperty("recoveryIdentity");
  });

  it("rejects an already-spent note before running the Groth16 prover", async () => {
    const note: Note = {
      asset: "TON",
      denominationUnits: 10_000_000_000n,
      leafIndex: 0,
      nullifier: 7n,
      secret: 13n,
      poolAddress: POOL,
      poolKind: "ton",
    };
    const commitment = await poseidon2(note.nullifier, note.secret);
    const tree = await buildTree(poseidon2, [commitment]);
    const { provider } = providerFor(tree, 1);
    vi.spyOn(provider, "sparseSetWitness")
      .mockRejectedValueOnce(new Error("nullifier key is already present"));
    const prover = vi.fn(async () => ({ proof: proof(), publicSignals: [] }));
    await expect(buildWithdraw(clientFor(tonPoolData(1, tree.root)), {
      kind: "ton",
      note,
      poolAddress: POOL,
      recipientAddress: USER,
      stateProvider: provider,
      poseidon2,
      withdrawProver: prover,
    })).rejects.toThrow(/already present/);
    expect(prover).not.toHaveBeenCalled();
  });

  it("uses full-address binding by default and legacy only when explicit", async () => {
    const note: Note = {
      asset: "TON",
      denominationUnits: 10_000_000_000n,
      leafIndex: 0,
      nullifier: 7n,
      secret: 13n,
      poolAddress: POOL,
      poolKind: "ton",
    };
    const commitment = await poseidon2(note.nullifier, note.secret);
    const tree = await buildTree(poseidon2, [commitment]);
    const { provider } = providerFor(tree, 1);
    const defaultProver = vi.fn(async (_witness: Record<string, unknown>) => ({
      proof: proof(),
      publicSignals: [],
    }));
    const legacyProver = vi.fn(async (_witness: Record<string, unknown>) => ({
      proof: proof(),
      publicSignals: [],
    }));
    const common = {
      kind: "ton" as const,
      note,
      poolAddress: POOL,
      recipientAddress: USER,
      stateProvider: provider,
      poseidon2,
    };

    const defaultPlan = await buildWithdraw(clientFor(tonPoolData(1, tree.root)), {
      ...common,
      withdrawProver: defaultProver,
    });
    const legacyPlan = await buildWithdraw(
      clientFor(tonPoolData(1, tree.root), LEGACY_TON_POOL_CODE_BOC),
      {
        ...common,
        recipientBinding: "legacy-low248",
        legacySelfBroadcastOnly: true,
        withdrawProver: legacyProver,
      },
    );

    expect(defaultProver).toHaveBeenCalledWith(expect.objectContaining({
      recipient: addressToField(USER).toString(),
    }));
    expect(legacyProver).toHaveBeenCalledWith(expect.objectContaining({
      recipient: legacyAddressToField(USER).toString(),
    }));
    expect(addressToField(USER)).not.toEqual(legacyAddressToField(USER));
    expect(defaultPlan).toMatchObject({
      recipientBinding: "full-address",
      relaySafe: true,
    });
    expect(legacyPlan).toMatchObject({
      recipientBinding: "legacy-low248",
      relaySafe: false,
    });

    const unacknowledgedProver = vi.fn(
      async (_witness: Record<string, unknown>) => ({
        proof: proof(),
        publicSignals: [],
      }),
    );
    await expect(buildWithdraw(clientFor(tonPoolData(1, tree.root)), {
      ...common,
      recipientBinding: "legacy-low248",
      withdrawProver: unacknowledgedProver,
    } as unknown as WithdrawOptions)).rejects.toThrow(
      /legacySelfBroadcastOnly: true/,
    );
    expect(unacknowledgedProver).not.toHaveBeenCalled();
  });

  it("requires the legacy self-broadcast acknowledgement at type level", () => {
    type CommonOptions = Omit<
      WithdrawOptions,
      "recipientBinding" | "legacySelfBroadcastOnly"
    >;
    expectTypeOf<CommonOptions & {
      recipientBinding: "legacy-low248";
    }>().not.toMatchTypeOf<WithdrawOptions>();
    expectTypeOf<CommonOptions & {
      recipientBinding: "legacy-low248";
      legacySelfBroadcastOnly: true;
    }>().toMatchTypeOf<WithdrawOptions>();
  });

  it("fails closed on absent, unknown, kind-mismatched, or mode-mismatched code", async () => {
    const note: Note = {
      asset: "TON",
      denominationUnits: 10_000_000_000n,
      leafIndex: 0,
      nullifier: 7n,
      secret: 13n,
      poolAddress: POOL,
      poolKind: "ton",
    };
    const commitment = await poseidon2(note.nullifier, note.secret);
    const tree = await buildTree(poseidon2, [commitment]);
    const { provider, sync } = providerFor(tree, 1);
    const prover = vi.fn(async (_witness: Record<string, unknown>) => ({
      proof: proof(),
      publicSignals: [],
    }));
    const data = tonPoolData(1, tree.root);
    const common = {
      kind: "ton" as const,
      note,
      poolAddress: POOL,
      recipientAddress: USER,
      stateProvider: provider,
      poseidon2,
      withdrawProver: prover,
    };
    const unknownCode = beginCell()
      .storeUint(0xdeadbeef, 32)
      .endCell()
      .toBoc()
      .toString("base64");

    await expect(buildWithdraw(clientFor(data, null), common))
      .rejects.toThrow(/code is unavailable/);
    await expect(buildWithdraw(clientFor(data, unknownCode), common))
      .rejects.toThrow(/Unknown Pool code hash/);
    await expect(buildWithdraw(clientFor(data, SECURE_POOL_CODE_BOC), common))
      .rejects.toThrow(/kind mismatch/);
    await expect(buildWithdraw(clientFor(data, LEGACY_TON_POOL_CODE_BOC), common))
      .rejects.toThrow(/binding mismatch/);
    await expect(buildWithdraw(clientFor(data, SECURE_TON_POOL_CODE_BOC), {
      ...common,
      recipientBinding: "legacy-low248",
      legacySelfBroadcastOnly: true,
    })).rejects.toThrow(/binding mismatch/);

    expect(sync).not.toHaveBeenCalled();
    expect(prover).not.toHaveBeenCalled();
  });

  it("snapshots validated withdrawal inputs before the async code preflight", async () => {
    const note: Note = {
      asset: "TON",
      denominationUnits: 10_000_000_000n,
      leafIndex: 0,
      nullifier: 7n,
      secret: 13n,
      poolAddress: POOL,
      poolKind: "ton",
    };
    const commitment = await poseidon2(note.nullifier, note.secret);
    const tree = await buildTree(poseidon2, [commitment]);
    const { provider } = providerFor(tree, 1);
    const prover = vi.fn(async (_witness: Record<string, unknown>) => ({
      proof: proof(),
      publicSignals: [],
    }));
    const originalClient = clientFor(tonPoolData(1, tree.root));
    const mutatedPool = Address.parseRaw(`0:${"66".repeat(32)}`).toString();
    const mutatedRecipient = Address.parseRaw(`0:${"77".repeat(32)}`).toString();
    let mutableOptions: WithdrawOptions;
    const getAccountState = vi.fn(async (address: string) => {
      const account = await originalClient.getAccountState(address);
      if (getAccountState.mock.calls.length === 1) {
        mutableOptions.poolAddress = mutatedPool;
        mutableOptions.recipientAddress = mutatedRecipient;
        mutableOptions.kind = "jetton";
        mutableOptions.queryId = 999n;
        mutableOptions.withdrawProver = vi.fn(async () => {
          throw new Error("mutated prover must not run");
        });
        note.poolAddress = mutatedPool;
        note.poolKind = "jetton";
        note.secret = 999n;
      }
      return account;
    });
    const client: Client = { ...originalClient, getAccountState };
    mutableOptions = {
      kind: "ton",
      note,
      poolAddress: POOL,
      recipientAddress: USER,
      queryId: 77n,
      stateProvider: provider,
      poseidon2,
      withdrawProver: prover,
    };

    const plan = await buildWithdraw(client, mutableOptions);
    const body = plan.message.payload.beginParse();
    body.skip(32 + 64 + 256 + 256);

    expect(getAccountState).toHaveBeenNthCalledWith(1, POOL);
    expect(getAccountState).toHaveBeenNthCalledWith(2, POOL);
    expect(plan.message.address).toBe(POOL);
    expect(body.loadAddress().equals(Address.parse(USER))).toBe(true);
    expect(plan.queryId).toBe(77n);
    expect(plan).toMatchObject({
      recipientBinding: "full-address",
      relaySafe: true,
    });
    expect(prover).toHaveBeenCalledTimes(1);
  });

  it("rejects runtime notes without mandatory pool binding metadata", async () => {
    const tree = await buildTree(poseidon2, []);
    const { provider, sync } = providerFor(tree, 0);
    const base = {
      asset: "TON",
      denominationUnits: 10_000_000_000n,
      leafIndex: 0,
      nullifier: 7n,
      secret: 13n,
      poolAddress: POOL,
      poolKind: "ton" as const,
    };
    const common = {
      kind: "ton" as const,
      poolAddress: POOL,
      recipientAddress: USER,
      stateProvider: provider,
      poseidon2,
      withdrawProver: vi.fn(async () => ({ proof: proof(), publicSignals: [] })),
    };
    await expect(buildWithdraw(clientFor(tonPoolData(0, tree.root)), {
      ...common,
      note: { ...base, poolAddress: undefined } as unknown as Note,
    })).rejects.toThrow(/missing its pool address/);
    await expect(buildWithdraw(clientFor(tonPoolData(0, tree.root)), {
      ...common,
      note: { ...base, poolKind: undefined } as unknown as Note,
    })).rejects.toThrow(/missing its pool kind/);
    expect(sync).not.toHaveBeenCalled();
  });
});
