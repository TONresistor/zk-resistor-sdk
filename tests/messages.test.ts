import { describe, it, expect } from "vitest";
import { Address, beginCell } from "@ton/core";
import {
  buildCreatePool,
  buildCreateTonPool,
  buildDepositJetton,
  buildDepositTon,
  buildWithdrawMessage,
  buildDepositPayloadCell,
  buildTonDepositPayloadCell,
} from "../src/messages.js";
import {
  MIN_CREATE_POOL_FEE,
  MIN_DEPOSIT_VALUE,
  MIN_WITHDRAW_GAS,
  OP_CREATE_POOL,
  OP_CREATE_TON_POOL,
  OP_DEPOSIT,
  OP_JETTON_TRANSFER,
  OP_WITHDRAW,
} from "../src/constants.js";

const FACTORY = "EQCncgvIPeN7jr5Di7TYKUtM_NMYM9ghSm6o3ibxovx1iGPu";
const POOL_ADDR = "EQABoe2lCyE_HCq48GinrdEKn3iifaiivxsl82W7ws3vG9sM";
const USER_ADDR = "EQB8PZ-Cp6UzydbLvjukx1OQL3LmqeYV-tJ3qVMw_mNYgqow";
const USER_JW_ADDR = "EQBh2E7Tc_OKGOl6Y20UgwXYx_79XnqCwzS7YgcQqQUUXvpW";
const JETTON_MASTER = "EQBZ_cafPyDr5KUTs0aNxh0ZTDhkpEZONmLJA2SNGlLm4Cko";

describe("buildCreatePool", () => {
  it("encodes opcode and attaches default fee", () => {
    const m = buildCreatePool({
      factoryAddress: FACTORY,
      jettonMaster: JETTON_MASTER,
      denomination: 1_000_000_000_000n,
    });
    expect(m.address).toBe(FACTORY);
    expect(m.value).toBe(MIN_CREATE_POOL_FEE + 100_000_000n);
    expect(m.payload.beginParse().loadUint(32)).toBe(OP_CREATE_POOL);
  });

  it("body is op + queryId + jettonMaster + denomination, with no wallet address", () => {
    const m = buildCreatePool({
      factoryAddress: FACTORY,
      jettonMaster: JETTON_MASTER,
      denomination: 1_000_000_000_000n,
    });
    const cs = m.payload.beginParse();
    expect(cs.loadUint(32)).toBe(OP_CREATE_POOL);
    cs.loadUint(64);
    expect(cs.loadAddress().equals(Address.parse(JETTON_MASTER))).toBe(true);
    expect(cs.loadCoins()).toBe(1_000_000_000_000n);
    expect(cs.remainingBits).toBe(0);
    expect(cs.remainingRefs).toBe(0);
  });
});

describe("buildCreateTonPool", () => {
  it("encodes opcode and accepts denomination", () => {
    const m = buildCreateTonPool({
      factoryAddress: FACTORY,
      denomination: 10_000_000_000n,
    });
    const cs = m.payload.beginParse();
    expect(cs.loadUint(32)).toBe(OP_CREATE_TON_POOL);
    cs.loadUint(64);
    expect(cs.loadCoins()).toBe(10_000_000_000n);
  });
});

describe("buildWithdrawMessage", () => {
  it("uses MIN_WITHDRAW_GAS by default and encodes the withdraw opcode", () => {
    const m = buildWithdrawMessage({
      poolAddress: POOL_ADDR,
      root: 12345n,
      nullifierHash: 67890n,
      recipient: USER_ADDR,
      proofCell: beginCell().endCell(),
    });
    expect(m.value).toBe(MIN_WITHDRAW_GAS);
    expect(m.payload.beginParse().loadUint(32)).toBe(OP_WITHDRAW);
  });

  it("encodes op + queryId + root + nullifierHash + recipient + proof ref", () => {
    const m = buildWithdrawMessage({
      poolAddress: POOL_ADDR,
      root: 0x1111n,
      nullifierHash: 0x2222n,
      recipient: USER_ADDR,
      proofCell: beginCell().endCell(),
    });
    const cs = m.payload.beginParse();
    expect(cs.loadUint(32)).toBe(OP_WITHDRAW);
    cs.loadUint(64);
    expect(cs.loadUintBig(256)).toBe(0x1111n);
    expect(cs.loadUintBig(256)).toBe(0x2222n);
    expect(cs.loadAddress().equals(Address.parse(USER_ADDR))).toBe(true);
    expect(cs.remainingRefs).toBe(1);
  });
});

describe("buildDepositPayloadCell", () => {
  it("contains opcode + commitment + newRoot + proof ref", () => {
    const c = buildDepositPayloadCell({
      commitment: 1n,
      newRoot: 2n,
      proofCell: beginCell().endCell(),
    });
    const cs = c.beginParse();
    expect(cs.loadUint(32)).toBe(OP_DEPOSIT);
    cs.loadUint(64);
    expect(cs.loadUintBig(256)).toBe(1n);
    expect(cs.loadUintBig(256)).toBe(2n);
    expect(cs.remainingRefs).toBe(1);
  });
});

describe("buildTonDepositPayloadCell", () => {
  it("includes the fromUser address", () => {
    const c = buildTonDepositPayloadCell({
      fromUser: USER_ADDR,
      commitment: 1n,
      newRoot: 2n,
      proofCell: beginCell().endCell(),
    });
    const cs = c.beginParse();
    expect(cs.loadUint(32)).toBe(OP_DEPOSIT);
    cs.loadUint(64);
    expect(cs.loadAddress().equals(Address.parse(USER_ADDR))).toBe(true);
    expect(cs.loadUintBig(256)).toBe(1n);
    expect(cs.loadUintBig(256)).toBe(2n);
    expect(cs.remainingRefs).toBe(1);
  });
});

describe("buildDepositJetton", () => {
  const depositPayload = buildDepositPayloadCell({
    commitment: 0xc0ffeen,
    newRoot: 0xbeefn,
    proofCell: beginCell().endCell(),
  });

  it("targets the user's jetton wallet, not the pool", () => {
    const m = buildDepositJetton({
      userJettonWallet: USER_JW_ADDR,
      fromUser: USER_ADDR,
      poolAddress: POOL_ADDR,
      denomination: 1_000_000_000_000n,
      depositPayload,
    });
    expect(m.address).toBe(USER_JW_ADDR);
    expect(m.value).toBe(650_000_000n);
  });

  it("encodes a TEP-74 transfer with the deposit payload as a ref forward_payload", () => {
    const m = buildDepositJetton({
      userJettonWallet: USER_JW_ADDR,
      fromUser: USER_ADDR,
      poolAddress: POOL_ADDR,
      denomination: 1_000_000_000_000n,
      depositPayload,
    });
    const cs = m.payload.beginParse();
    expect(cs.loadUint(32)).toBe(OP_JETTON_TRANSFER);
    cs.loadUint(64);
    expect(cs.loadCoins()).toBe(1_000_000_000_000n);
    expect(cs.loadAddress().equals(Address.parse(POOL_ADDR))).toBe(true);
    expect(cs.loadAddress().equals(Address.parse(USER_ADDR))).toBe(true);
    expect(cs.loadBit()).toBe(false);
    expect(cs.loadCoins()).toBe(MIN_DEPOSIT_VALUE);
    expect(cs.loadBit()).toBe(true);
    expect(cs.loadRef().beginParse().loadUint(32)).toBe(OP_DEPOSIT);
  });

  it("respects custom forwardAmount and value overrides", () => {
    const m = buildDepositJetton({
      userJettonWallet: USER_JW_ADDR,
      fromUser: USER_ADDR,
      poolAddress: POOL_ADDR,
      denomination: 1n,
      depositPayload,
      value: 999_000_000n,
      forwardAmount: 800_000_000n,
    });
    expect(m.value).toBe(999_000_000n);
    const cs = m.payload.beginParse();
    cs.loadUint(32);
    cs.loadUint(64);
    cs.loadCoins();
    cs.loadAddress();
    cs.loadAddress();
    cs.loadBit();
    expect(cs.loadCoins()).toBe(800_000_000n);
  });
});

describe("buildDepositTon", () => {
  it("attaches denomination + MIN_DEPOSIT_VALUE and targets the pool directly", () => {
    const payload = buildTonDepositPayloadCell({
      fromUser: USER_ADDR,
      commitment: 1n,
      newRoot: 2n,
      proofCell: beginCell().endCell(),
    });
    const m = buildDepositTon({
      poolAddress: POOL_ADDR,
      fromUser: USER_ADDR,
      denomination: 10_000_000_000n,
      depositPayload: payload,
    });
    expect(m.address).toBe(POOL_ADDR);
    expect(m.value).toBe(10_000_000_000n + MIN_DEPOSIT_VALUE);
    expect(m.payload.beginParse().loadUint(32)).toBe(OP_DEPOSIT);
  });
});
