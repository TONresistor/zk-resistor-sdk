import { Address, beginCell } from "@ton/core";
import type { Cell } from "@ton/core";
import {
  MIN_CREATE_POOL_FEE,
  MIN_DEPOSIT_VALUE,
  MIN_WITHDRAW_GAS,
  OP_CREATE_POOL,
  OP_CREATE_TON_POOL,
  OP_DEPOSIT,
  OP_JETTON_TRANSFER,
  OP_WITHDRAW,
} from "./constants.js";

export interface BuiltMessage {
  address: string;
  value: bigint;
  payload: Cell;
}

function nextQueryId(): bigint {
  return BigInt(Date.now()) & 0xffffffffffffffffn;
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
  const payload = beginCell()
    .storeUint(OP_CREATE_POOL, 32)
    .storeUint(opts.queryId ?? nextQueryId(), 64)
    .storeAddress(Address.parse(opts.jettonMaster))
    .storeCoins(opts.denomination)
    .endCell();
  return {
    address: opts.factoryAddress,
    value: opts.value ?? MIN_CREATE_POOL_FEE + 100_000_000n, // 0.30 TON
    payload,
  };
}

export interface CreateTonPoolOptions {
  factoryAddress: string;
  denomination: bigint;
  value?: bigint;
  queryId?: bigint;
}

export function buildCreateTonPool(opts: CreateTonPoolOptions): BuiltMessage {
  const payload = beginCell()
    .storeUint(OP_CREATE_TON_POOL, 32)
    .storeUint(opts.queryId ?? nextQueryId(), 64)
    .storeCoins(opts.denomination)
    .endCell();
  return {
    address: opts.factoryAddress,
    value: opts.value ?? MIN_CREATE_POOL_FEE + 100_000_000n, // 0.30 TON
    payload,
  };
}

export interface DepositPayloadCellOptions {
  commitment: bigint;
  newRoot: bigint;
  proofCell: Cell;
  queryId?: bigint;
}

export function buildDepositPayloadCell(opts: DepositPayloadCellOptions): Cell {
  return beginCell()
    .storeUint(OP_DEPOSIT, 32)
    .storeUint(opts.queryId ?? nextQueryId(), 64)
    .storeUint(opts.commitment, 256)
    .storeUint(opts.newRoot, 256)
    .storeRef(opts.proofCell)
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
  const transferBody = beginCell()
    .storeUint(OP_JETTON_TRANSFER, 32)
    .storeUint(opts.queryId ?? nextQueryId(), 64)
    .storeCoins(opts.denomination)
    .storeAddress(Address.parse(opts.poolAddress))
    .storeAddress(Address.parse(opts.fromUser))
    .storeBit(false) // custom_payload: none
    .storeCoins(opts.forwardAmount ?? MIN_DEPOSIT_VALUE)
    .storeBit(true) // forward_payload: Either right side (ref)
    .storeRef(opts.depositPayload)
    .endCell();
  return {
    address: opts.userJettonWallet,
    // 0.65 TON: covers forward_amount plus two jetton-wallet hops; the unused
    // remainder returns to fromUser as TEP-74 excesses.
    value: opts.value ?? 650_000_000n,
    payload: transferBody,
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
  return {
    address: opts.poolAddress,
    value: opts.value ?? opts.denomination + MIN_DEPOSIT_VALUE + 50_000_000n,
    payload: opts.depositPayload,
  };
}

export interface TonDepositPayloadCellOptions {
  fromUser: string;
  commitment: bigint;
  newRoot: bigint;
  proofCell: Cell;
  queryId?: bigint;
}

// TonPool's deposit payload carries fromUser; the jetton one does not.
export function buildTonDepositPayloadCell(
  opts: TonDepositPayloadCellOptions,
): Cell {
  return beginCell()
    .storeUint(OP_DEPOSIT, 32)
    .storeUint(opts.queryId ?? nextQueryId(), 64)
    .storeAddress(Address.parse(opts.fromUser))
    .storeUint(opts.commitment, 256)
    .storeUint(opts.newRoot, 256)
    .storeRef(opts.proofCell)
    .endCell();
}

export interface WithdrawOptions {
  poolAddress: string;
  root: bigint;
  nullifierHash: bigint;
  recipient: string;
  proofCell: Cell;
  value?: bigint;
  queryId?: bigint;
}

export function buildWithdrawMessage(opts: WithdrawOptions): BuiltMessage {
  const payload = beginCell()
    .storeUint(OP_WITHDRAW, 32)
    .storeUint(opts.queryId ?? nextQueryId(), 64)
    .storeUint(opts.root, 256)
    .storeUint(opts.nullifierHash, 256)
    .storeAddress(Address.parse(opts.recipient))
    .storeRef(opts.proofCell)
    .endCell();
  return {
    address: opts.poolAddress,
    value: opts.value ?? MIN_WITHDRAW_GAS + 50_000_000n,
    payload,
  };
}
