import { describe, it, expect } from "vitest";
import { Address, beginCell } from "@ton/core";
import {
  buildCreatePool,
  buildCreateTonPool,
  buildDepositJetton,
  buildDepositTon,
  buildInitWalletBinding,
  buildWithdrawMessage,
  buildDepositPayloadCell,
  buildTonDepositPayloadCell,
} from "../src/messages.js";
import {
  BLS12_381_R,
  MIN_CREATE_JETTON_POOL_FEE,
  MIN_CREATE_TON_POOL_FEE,
  MIN_DEPOSIT_VALUE,
  MIN_INIT_WALLET_BINDING_VALUE,
  MIN_POOL_CONFIRMATION_VALUE,
  MIN_WITHDRAW_GAS,
  MIN_JETTON_WITHDRAW_GAS,
  OP_CREATE_POOL,
  OP_CREATE_TON_POOL,
  OP_DEPOSIT,
  OP_JETTON_TRANSFER,
  OP_INIT_WALLET_BINDING,
  OP_WITHDRAW,
} from "../src/constants.js";

const FACTORY = "EQCncgvIPeN7jr5Di7TYKUtM_NMYM9ghSm6o3ibxovx1iGPu";
const POOL_ADDR = "EQABoe2lCyE_HCq48GinrdEKn3iifaiivxsl82W7ws3vG9sM";
const USER_ADDR = "EQB8PZ-Cp6UzydbLvjukx1OQL3LmqeYV-tJ3qVMw_mNYgqow";
const USER_JW_ADDR = "EQBh2E7Tc_OKGOl6Y20UgwXYx_79XnqCwzS7YgcQqQUUXvpW";
const JETTON_MASTER = "EQBZ_cafPyDr5KUTs0aNxh0ZTDhkpEZONmLJA2SNGlLm4Cko";
const EMPTY_SPARSE_PROOF = {
  expectedRoot: 0n,
  siblingBitmap: 0n,
  siblings: [] as bigint[],
};

describe("buildCreatePool", () => {
  it("encodes opcode and attaches default fee", () => {
    const m = buildCreatePool({
      factoryAddress: FACTORY,
      jettonMaster: JETTON_MASTER,
      denomination: 1_000_000_000_000n,
    });
    expect(m.address).toBe(FACTORY);
    expect(m.value).toBe(MIN_CREATE_JETTON_POOL_FEE + 100_000_000n);
    expect(m.payload.beginParse().loadUint(32)).toBe(OP_CREATE_POOL);
  });

  it("rejects a non-positive denomination and an underfunded value", () => {
    expect(() => buildCreatePool({
      factoryAddress: FACTORY,
      jettonMaster: JETTON_MASTER,
      denomination: 0n,
    })).toThrow(/positive/);
    expect(() => buildCreatePool({
      factoryAddress: FACTORY,
      jettonMaster: JETTON_MASTER,
      denomination: 1n,
      value: MIN_CREATE_JETTON_POOL_FEE - 1n,
    })).toThrow(/at least/);
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
    expect(m.value).toBe(MIN_CREATE_TON_POOL_FEE + 100_000_000n);
  });

  it("rejects an underfunded value", () => {
    expect(() => buildCreateTonPool({
      factoryAddress: FACTORY,
      denomination: 10_000_000_000n,
      value: MIN_CREATE_TON_POOL_FEE - 1n,
    })).toThrow(/at least/);
  });

  it("rejects a denomination outside the contract whitelist", () => {
    expect(() => buildCreateTonPool({
      factoryAddress: FACTORY,
      denomination: 11_000_000_000n,
    })).toThrow(/allowed TON Pool denomination/);
  });
});

describe("buildWithdrawMessage", () => {
  it("defaults to the Jetton withdraw floor plus headroom", () => {
    const m = buildWithdrawMessage({
      poolAddress: POOL_ADDR,
      root: 12345n,
      nullifierHash: 67890n,
      recipient: USER_ADDR,
      proofCell: beginCell().endCell(),
      nullifierSetProof: EMPTY_SPARSE_PROOF,
    });
    expect(m.value).toBe(MIN_JETTON_WITHDRAW_GAS + 50_000_000n);
    expect(m.payload.beginParse().loadUint(32)).toBe(OP_WITHDRAW);
  });

  it("rejects explicit values below the selected pool floor", () => {
    const base = {
      poolAddress: POOL_ADDR,
      root: 1n,
      nullifierHash: 2n,
      recipient: USER_ADDR,
      proofCell: beginCell().endCell(),
      nullifierSetProof: EMPTY_SPARSE_PROOF,
    };
    expect(() => buildWithdrawMessage({
      ...base,
      value: MIN_JETTON_WITHDRAW_GAS - 1n,
    })).toThrow(/at least/);
    expect(() => buildWithdrawMessage({
      ...base,
      poolKind: "ton",
      value: MIN_WITHDRAW_GAS - 1n,
    })).toThrow(/at least/);
  });

  it("uses the lower native TON floor only when explicitly selected", () => {
    const m = buildWithdrawMessage({
      poolAddress: POOL_ADDR,
      root: 1n,
      nullifierHash: 2n,
      recipient: USER_ADDR,
      proofCell: beginCell().endCell(),
      nullifierSetProof: EMPTY_SPARSE_PROOF,
      poolKind: "ton",
    });
    expect(m.value).toBe(MIN_WITHDRAW_GAS + 50_000_000n);
  });

  it("encodes op + queryId + root + nullifierHash + recipient + proof ref", () => {
    const m = buildWithdrawMessage({
      poolAddress: POOL_ADDR,
      root: 0x1111n,
      nullifierHash: 0x2222n,
      recipient: USER_ADDR,
      proofCell: beginCell().endCell(),
      nullifierSetProof: EMPTY_SPARSE_PROOF,
    });
    const cs = m.payload.beginParse();
    expect(cs.loadUint(32)).toBe(OP_WITHDRAW);
    cs.loadUint(64);
    expect(cs.loadUintBig(256)).toBe(0x1111n);
    expect(cs.loadUintBig(256)).toBe(0x2222n);
    expect(cs.loadAddress().equals(Address.parse(USER_ADDR))).toBe(true);
    expect(cs.remainingRefs).toBe(2);
  });

  it("rejects root/nullifier values outside the BLS12-381 scalar field", () => {
    expect(() =>
      buildWithdrawMessage({
        poolAddress: POOL_ADDR,
        root: BLS12_381_R,
        nullifierHash: 1n,
        recipient: USER_ADDR,
        proofCell: beginCell().endCell(),
        nullifierSetProof: EMPTY_SPARSE_PROOF,
      }),
    ).toThrow(/BLS12-381 scalar/);
    expect(() =>
      buildWithdrawMessage({
        poolAddress: POOL_ADDR,
        root: 1n,
        nullifierHash: BLS12_381_R,
        recipient: USER_ADDR,
        proofCell: beginCell().endCell(),
        nullifierSetProof: EMPTY_SPARSE_PROOF,
      }),
    ).toThrow(/BLS12-381 scalar/);
  });

  it("rejects masterchain and zero recipients before building a proof-bound payout", () => {
    const base = {
      poolAddress: POOL_ADDR,
      root: 1n,
      nullifierHash: 2n,
      proofCell: beginCell().endCell(),
      nullifierSetProof: EMPTY_SPARSE_PROOF,
    };
    expect(() => buildWithdrawMessage({
      ...base,
      recipient: Address.parseRaw(`-1:${"11".repeat(32)}`).toString(),
    })).toThrow(/non-zero basechain/);
    expect(() => buildWithdrawMessage({
      ...base,
      recipient: Address.parseRaw(`0:${"00".repeat(32)}`).toString(),
    })).toThrow(/non-zero basechain/);
  });

  it("accepts the full clientQueryId uint64 and rejects overflow", () => {
    expect(buildWithdrawMessage({
      poolAddress: POOL_ADDR,
      root: 1n,
      nullifierHash: 2n,
      recipient: USER_ADDR,
      proofCell: beginCell().endCell(),
      nullifierSetProof: EMPTY_SPARSE_PROOF,
      queryId: 1n << 63n,
    }).queryId).toBe(1n << 63n);
    expect(() => buildWithdrawMessage({
      poolAddress: POOL_ADDR,
      root: 1n,
      nullifierHash: 2n,
      recipient: USER_ADDR,
      proofCell: beginCell().endCell(),
      nullifierSetProof: EMPTY_SPARSE_PROOF,
      queryId: 1n << 64n,
    })).toThrow(/64 bits/);
  });

  it("returns the query id used in the withdraw payload", () => {
    const m = buildWithdrawMessage({
      poolAddress: POOL_ADDR,
      root: 1n,
      nullifierHash: 2n,
      recipient: USER_ADDR,
      proofCell: beginCell().endCell(),
      nullifierSetProof: EMPTY_SPARSE_PROOF,
      queryId: 123n,
    });
    expect(m.queryId).toBe(123n);
    const cs = m.payload.beginParse();
    cs.loadUint(32);
    expect(cs.loadUintBig(64)).toBe(123n);
  });
});

describe("buildDepositPayloadCell", () => {
  it("contains opcode + commitment + newRoot + proof ref", () => {
    const c = buildDepositPayloadCell({
      commitment: 1n,
      newRoot: 2n,
      proofCell: beginCell().endCell(),
      commitmentSetProof: EMPTY_SPARSE_PROOF,
    });
    const cs = c.beginParse();
    expect(cs.loadUint(32)).toBe(OP_DEPOSIT);
    cs.loadUint(64);
    expect(cs.loadUintBig(256)).toBe(1n);
    expect(cs.loadUintBig(256)).toBe(2n);
    expect(cs.remainingRefs).toBe(2);
  });

  it("rejects commitment/newRoot values outside the BLS12-381 scalar field", () => {
    expect(() =>
      buildDepositPayloadCell({
        commitment: BLS12_381_R,
        newRoot: 2n,
        proofCell: beginCell().endCell(),
        commitmentSetProof: EMPTY_SPARSE_PROOF,
      }),
    ).toThrow(/BLS12-381 scalar/);
    expect(() =>
      buildDepositPayloadCell({
        commitment: 1n,
        newRoot: BLS12_381_R,
        proofCell: beginCell().endCell(),
        commitmentSetProof: EMPTY_SPARSE_PROOF,
      }),
    ).toThrow(/BLS12-381 scalar/);
  });
});

describe("buildTonDepositPayloadCell", () => {
  it("includes the fromUser address", () => {
    const c = buildTonDepositPayloadCell({
      fromUser: USER_ADDR,
      commitment: 1n,
      newRoot: 2n,
      proofCell: beginCell().endCell(),
      commitmentSetProof: EMPTY_SPARSE_PROOF,
    });
    const cs = c.beginParse();
    expect(cs.loadUint(32)).toBe(OP_DEPOSIT);
    cs.loadUint(64);
    expect(cs.loadAddress().equals(Address.parse(USER_ADDR))).toBe(true);
    expect(cs.loadUintBig(256)).toBe(1n);
    expect(cs.loadUintBig(256)).toBe(2n);
    expect(cs.remainingRefs).toBe(2);
  });
});

describe("buildDepositJetton", () => {
  const depositPayload = buildDepositPayloadCell({
    commitment: 0xc0ffeen,
    newRoot: 0xbeefn,
    proofCell: beginCell().endCell(),
    commitmentSetProof: EMPTY_SPARSE_PROOF,
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
      value: 1_100_000_000n,
      forwardAmount: 800_000_000n,
    });
    expect(m.value).toBe(1_100_000_000n);
    const cs = m.payload.beginParse();
    cs.loadUint(32);
    cs.loadUint(64);
    cs.loadCoins();
    cs.loadAddress();
    cs.loadAddress();
    cs.loadBit();
    expect(cs.loadCoins()).toBe(800_000_000n);
  });

  it("rejects a forwardAmount below the Pool floor before signing", () => {
    expect(() => buildDepositJetton({
      userJettonWallet: USER_JW_ADDR,
      fromUser: USER_ADDR,
      poolAddress: POOL_ADDR,
      denomination: 1n,
      depositPayload,
      forwardAmount: MIN_DEPOSIT_VALUE - 1n,
    })).toThrow(/forwardAmount must be at least/);
  });

  it("raises the default outer value with a custom forwardAmount", () => {
    const m = buildDepositJetton({
      userJettonWallet: USER_JW_ADDR,
      fromUser: USER_ADDR,
      poolAddress: POOL_ADDR,
      denomination: 1n,
      depositPayload,
      forwardAmount: 800_000_000n,
    });
    expect(m.value).toBe(1_080_000_000n);
  });

  it("rejects an outer value that cannot fund the forward and wallet hops", () => {
    expect(() => buildDepositJetton({
      userJettonWallet: USER_JW_ADDR,
      fromUser: USER_ADDR,
      poolAddress: POOL_ADDR,
      denomination: 1n,
      depositPayload,
      value: MIN_DEPOSIT_VALUE,
    })).toThrow(/value must be at least/);
  });
});

describe("buildDepositTon", () => {
  it("attaches denomination + MIN_DEPOSIT_VALUE + headroom and targets the pool directly", () => {
    const payload = buildTonDepositPayloadCell({
      fromUser: USER_ADDR,
      commitment: 1n,
      newRoot: 2n,
      proofCell: beginCell().endCell(),
      commitmentSetProof: EMPTY_SPARSE_PROOF,
    });
    const m = buildDepositTon({
      poolAddress: POOL_ADDR,
      fromUser: USER_ADDR,
      denomination: 10_000_000_000n,
      depositPayload: payload,
    });
    expect(m.address).toBe(POOL_ADDR);
    expect(m.value).toBe(10_000_000_000n + MIN_DEPOSIT_VALUE + 50_000_000n);
    expect(m.payload.beginParse().loadUint(32)).toBe(OP_DEPOSIT);
  });

  it("rejects a refund address mismatch and the Jetton payload shape", () => {
    const payload = buildTonDepositPayloadCell({
      fromUser: USER_ADDR,
      commitment: 1n,
      newRoot: 2n,
      proofCell: beginCell().endCell(),
      commitmentSetProof: EMPTY_SPARSE_PROOF,
    });
    expect(() => buildDepositTon({
      poolAddress: POOL_ADDR,
      fromUser: FACTORY,
      denomination: 10_000_000_000n,
      depositPayload: payload,
    })).toThrow(/fromUser/);

    const jettonPayload = buildDepositPayloadCell({
      commitment: 1n,
      newRoot: 2n,
      proofCell: beginCell().endCell(),
      commitmentSetProof: EMPTY_SPARSE_PROOF,
    });
    expect(() => buildDepositTon({
      poolAddress: POOL_ADDR,
      fromUser: USER_ADDR,
      denomination: 10_000_000_000n,
      depositPayload: jettonPayload,
    })).toThrow();
  });

  it("rejects a value below denomination plus the deposit floor", () => {
    const denomination = 10_000_000_000n;
    const payload = buildTonDepositPayloadCell({
      fromUser: USER_ADDR,
      commitment: 1n,
      newRoot: 2n,
      proofCell: beginCell().endCell(),
      commitmentSetProof: EMPTY_SPARSE_PROOF,
    });
    expect(() => buildDepositTon({
      poolAddress: POOL_ADDR,
      fromUser: USER_ADDR,
      denomination,
      depositPayload: payload,
      value: denomination + MIN_DEPOSIT_VALUE - 1n,
    })).toThrow(/at least/);
  });
});

describe("buildInitWalletBinding", () => {
  it("encodes the exact Pool message with the safe unbound default", () => {
    const m = buildInitWalletBinding({ poolAddress: POOL_ADDR, queryId: 77n });
    expect(m.address).toBe(POOL_ADDR);
    expect(m.value).toBe(MIN_INIT_WALLET_BINDING_VALUE);
    const body = m.payload.beginParse();
    expect(body.loadUint(32)).toBe(OP_INIT_WALLET_BINDING);
    expect(body.loadUintBig(64)).toBe(77n);
    expect(body.remainingBits).toBe(0);
    expect(body.remainingRefs).toBe(0);
  });

  it("rejects values below the unbound TEP-89 query budget", () => {
    expect(() => buildInitWalletBinding({
      poolAddress: POOL_ADDR,
      value: MIN_INIT_WALLET_BINDING_VALUE - 1n,
    })).toThrow(/at least/);
  });

  it("uses the lower budget only after an observed wallet binding", () => {
    const message = buildInitWalletBinding({
      poolAddress: POOL_ADDR,
      walletBound: true,
    });
    expect(message.value).toBe(MIN_POOL_CONFIRMATION_VALUE);
    expect(() => buildInitWalletBinding({
      poolAddress: POOL_ADDR,
      walletBound: true,
      value: MIN_POOL_CONFIRMATION_VALUE - 1n,
    })).toThrow(/at least/);
  });
});
