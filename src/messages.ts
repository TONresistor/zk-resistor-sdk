import { Address, beginCell, Cell } from "@ton/core";
import {
  BLS12_381_R,
  MIN_CREATE_JETTON_POOL_FEE,
  MIN_CREATE_TON_POOL_FEE,
  MIN_DEPOSIT_VALUE,
  MIN_INIT_WALLET_BINDING_VALUE,
  MIN_JETTON_WITHDRAW_GAS,
  MIN_POOL_CONFIRMATION_VALUE,
  MIN_WITHDRAW_GAS,
  OP_CREATE_POOL,
  OP_CREATE_TON_POOL,
  OP_DEPOSIT,
  OP_INIT_WALLET_BINDING,
  OP_JETTON_TRANSFER,
  OP_WITHDRAW,
  TON_POOL_DENOMINATIONS,
} from "./constants.js";
import {
  buildSparseSetUpdateProofCell,
  parseSparseSetUpdateProofCell,
  type SparseSetUpdateProof,
} from "./sparse-set.js";

export interface BuiltMessage {
  address: string;
  value: bigint;
  payload: Cell;
  queryId: bigint;
}

function nextQueryId(): bigint {
  return BigInt(Date.now()) & 0xffffffffffffffffn;
}

function assertFieldElement(name: string, value: bigint): void {
  if (value < 0n || value >= BLS12_381_R) {
    throw new RangeError(`${name} must be a BLS12-381 scalar field element`);
  }
}

function assertUint64(name: string, value: bigint): void {
  if (value < 0n || value >= 1n << 64n) {
    throw new RangeError(`${name} must fit in 64 bits`);
  }
}

function assertPositive(name: string, value: bigint): void {
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
}

function assertMinimum(name: string, value: bigint, minimum: bigint): void {
  if (value < minimum) {
    throw new RangeError(`${name} must be at least ${minimum} nanotons`);
  }
}

function parseRecipient(value: string): Address {
  const recipient = Address.parse(value);
  if (
    recipient.workChain !== 0 ||
    recipient.hash.every((byte) => byte === 0)
  ) {
    throw new RangeError("recipient must be a non-zero basechain address");
  }
  return recipient;
}

export type SparseSetProofInput = Cell | SparseSetUpdateProof;

function canonicalSparseSetProof(input: SparseSetProofInput): Cell {
  if (input instanceof Cell) {
    parseSparseSetUpdateProofCell(input);
    return input;
  }
  return buildSparseSetUpdateProofCell(input);
}

export interface CreatePoolOptions {
  factoryAddress: string;
  jettonMaster: string;
  denomination: bigint;
  value?: bigint;
  queryId?: bigint;
}

// The factory binds the pool's jetton wallet on-chain via TEP-89; the caller
// never supplies a wallet address.
export function buildCreatePool(opts: CreatePoolOptions): BuiltMessage {
  const queryId = opts.queryId ?? nextQueryId();
  assertUint64("queryId", queryId);
  assertPositive("denomination", opts.denomination);
  if (opts.value !== undefined) {
    assertMinimum("value", opts.value, MIN_CREATE_JETTON_POOL_FEE);
  }
  const payload = beginCell()
    .storeUint(OP_CREATE_POOL, 32)
    .storeUint(queryId, 64)
    .storeAddress(Address.parse(opts.jettonMaster))
    .storeCoins(opts.denomination)
    .endCell();
  return {
    address: opts.factoryAddress,
    value: opts.value ?? MIN_CREATE_JETTON_POOL_FEE + 100_000_000n, // 0.55 TON
    payload,
    queryId,
  };
}

export interface CreateTonPoolOptions {
  factoryAddress: string;
  denomination: bigint;
  value?: bigint;
  queryId?: bigint;
}

export function buildCreateTonPool(opts: CreateTonPoolOptions): BuiltMessage {
  const queryId = opts.queryId ?? nextQueryId();
  assertUint64("queryId", queryId);
  if (!TON_POOL_DENOMINATIONS.includes(opts.denomination as never)) {
    throw new RangeError("denomination is not an allowed TON Pool denomination");
  }
  if (opts.value !== undefined) {
    assertMinimum("value", opts.value, MIN_CREATE_TON_POOL_FEE);
  }
  const payload = beginCell()
    .storeUint(OP_CREATE_TON_POOL, 32)
    .storeUint(queryId, 64)
    .storeCoins(opts.denomination)
    .endCell();
  return {
    address: opts.factoryAddress,
    value: opts.value ?? MIN_CREATE_TON_POOL_FEE + 100_000_000n, // 0.55 TON
    payload,
    queryId,
  };
}

export interface DepositPayloadCellOptions {
  commitment: bigint;
  newRoot: bigint;
  proofCell: Cell;
  commitmentSetProof: SparseSetProofInput;
  queryId?: bigint;
}

export function buildDepositPayloadCell(opts: DepositPayloadCellOptions): Cell {
  assertFieldElement("commitment", opts.commitment);
  assertFieldElement("newRoot", opts.newRoot);
  const queryId = opts.queryId ?? nextQueryId();
  assertUint64("queryId", queryId);
  return beginCell()
    .storeUint(OP_DEPOSIT, 32)
    .storeUint(queryId, 64)
    .storeUint(opts.commitment, 256)
    .storeUint(opts.newRoot, 256)
    .storeRef(opts.proofCell)
    .storeRef(canonicalSparseSetProof(opts.commitmentSetProof))
    .endCell();
}

export interface DepositJettonOptions {
  userJettonWallet: string;
  fromUser: string;
  poolAddress: string;
  denomination: bigint;
  depositPayload: Cell;
  value?: bigint;
  forwardAmount?: bigint;
  queryId?: bigint;
}

export function buildDepositJetton(opts: DepositJettonOptions): BuiltMessage {
  const queryId = opts.queryId ?? nextQueryId();
  assertUint64("queryId", queryId);
  assertPositive("denomination", opts.denomination);
  const forwardAmount = opts.forwardAmount ?? MIN_DEPOSIT_VALUE;
  assertMinimum("forwardAmount", forwardAmount, MIN_DEPOSIT_VALUE);
  const minimumOuterValue = forwardAmount + 280_000_000n;
  const value = opts.value ?? minimumOuterValue;
  assertMinimum("value", value, minimumOuterValue);
  const transferBody = beginCell()
    .storeUint(OP_JETTON_TRANSFER, 32)
    .storeUint(queryId, 64)
    .storeCoins(opts.denomination)
    .storeAddress(Address.parse(opts.poolAddress))
    .storeAddress(Address.parse(opts.fromUser))
    .storeBit(false) // custom_payload: none
    .storeCoins(forwardAmount)
    .storeBit(true) // forward_payload: Either right side (ref)
    .storeRef(opts.depositPayload)
    .endCell();
  return {
    address: opts.userJettonWallet,
    // 0.65 TON: covers forward_amount plus two jetton-wallet hops; the unused
    // remainder returns to fromUser as TEP-74 excesses.
    value,
    payload: transferBody,
    queryId,
  };
}

export interface DepositTonOptions {
  poolAddress: string;
  fromUser: string;
  denomination: bigint;
  depositPayload: Cell;
  value?: bigint;
  queryId?: bigint;
}

export function buildDepositTon(opts: DepositTonOptions): BuiltMessage {
  assertPositive("denomination", opts.denomination);
  if (opts.depositPayload.isExotic || opts.depositPayload.refs.length !== 2) {
    throw new Error("depositPayload is not a canonical TonDepositPayload");
  }
  const payload = opts.depositPayload.beginParse();
  if (payload.loadUint(32) !== OP_DEPOSIT) {
    throw new Error("depositPayload does not contain a deposit message");
  }
  const payloadQueryId = payload.loadUintBig(64);
  const serializedFromUser = payload.loadAddress();
  if (!serializedFromUser.equals(Address.parse(opts.fromUser))) {
    throw new Error("fromUser does not match the serialized deposit payload");
  }
  payload.loadUintBig(256); // commitment
  payload.loadUintBig(256); // newRoot
  payload.loadRef(); // Groth16 proof
  payload.loadRef(); // sparse-set proof
  if (payload.remainingBits !== 0 || payload.remainingRefs !== 0) {
    throw new Error("depositPayload contains trailing data");
  }
  if (opts.queryId !== undefined && opts.queryId !== payloadQueryId) {
    throw new Error("queryId does not match the serialized deposit payload");
  }
  const minimumValue = opts.denomination + MIN_DEPOSIT_VALUE;
  if (opts.value !== undefined) {
    assertMinimum("value", opts.value, minimumValue);
  }
  return {
    address: opts.poolAddress,
    value: opts.value ?? opts.denomination + MIN_DEPOSIT_VALUE + 50_000_000n,
    payload: opts.depositPayload,
    queryId: payloadQueryId,
  };
}

export interface TonDepositPayloadCellOptions {
  fromUser: string;
  commitment: bigint;
  newRoot: bigint;
  proofCell: Cell;
  commitmentSetProof: SparseSetProofInput;
  queryId?: bigint;
}

// TonPool's deposit payload carries fromUser; the jetton one does not.
export function buildTonDepositPayloadCell(
  opts: TonDepositPayloadCellOptions,
): Cell {
  assertFieldElement("commitment", opts.commitment);
  assertFieldElement("newRoot", opts.newRoot);
  const queryId = opts.queryId ?? nextQueryId();
  assertUint64("queryId", queryId);
  return beginCell()
    .storeUint(OP_DEPOSIT, 32)
    .storeUint(queryId, 64)
    .storeAddress(Address.parse(opts.fromUser))
    .storeUint(opts.commitment, 256)
    .storeUint(opts.newRoot, 256)
    .storeRef(opts.proofCell)
    .storeRef(canonicalSparseSetProof(opts.commitmentSetProof))
    .endCell();
}

export interface WithdrawOptions {
  poolAddress: string;
  root: bigint;
  nullifierHash: bigint;
  recipient: string;
  proofCell: Cell;
  nullifierSetProof: SparseSetProofInput;
  value?: bigint;
  queryId?: bigint;
  /** Defaults to Jetton-safe funding when omitted. */
  poolKind?: "jetton" | "ton";
}

export function buildWithdrawMessage(opts: WithdrawOptions): BuiltMessage {
  assertFieldElement("root", opts.root);
  assertFieldElement("nullifierHash", opts.nullifierHash);
  const queryId = opts.queryId ?? nextQueryId();
  assertUint64("clientQueryId", queryId);
  const minimumValue = opts.poolKind === "ton"
    ? MIN_WITHDRAW_GAS
    : MIN_JETTON_WITHDRAW_GAS;
  if (opts.value !== undefined) {
    assertMinimum("value", opts.value, minimumValue);
  }
  const payload = beginCell()
    .storeUint(OP_WITHDRAW, 32)
    .storeUint(queryId, 64)
    .storeUint(opts.root, 256)
    .storeUint(opts.nullifierHash, 256)
    .storeAddress(parseRecipient(opts.recipient))
    .storeRef(opts.proofCell)
    .storeRef(canonicalSparseSetProof(opts.nullifierSetProof))
    .endCell();
  return {
    address: opts.poolAddress,
    value: opts.value ??
      (opts.poolKind === "ton" ? MIN_WITHDRAW_GAS : MIN_JETTON_WITHDRAW_GAS) +
        50_000_000n,
    payload,
    queryId,
  };
}

export interface InitWalletBindingOptions {
  poolAddress: string;
  /** Set only after reading a non-null wallet from current Pool storage. */
  walletBound?: boolean;
  value?: bigint;
  queryId?: bigint;
}

/** Retriggers TEP-89 wallet discovery, or Factory confirmation once bound. */
export function buildInitWalletBinding(
  opts: InitWalletBindingOptions,
): BuiltMessage {
  const queryId = opts.queryId ?? nextQueryId();
  assertUint64("queryId", queryId);
  const minimum = opts.walletBound
    ? MIN_POOL_CONFIRMATION_VALUE
    : MIN_INIT_WALLET_BINDING_VALUE;
  const value = opts.value ?? minimum;
  assertMinimum("value", value, minimum);
  return {
    address: opts.poolAddress,
    value,
    payload: beginCell()
      .storeUint(OP_INIT_WALLET_BINDING, 32)
      .storeUint(queryId, 64)
      .endCell(),
    queryId,
  };
}
