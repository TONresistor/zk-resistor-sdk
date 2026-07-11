import { describe, it, expect } from "vitest";
import {
  ADDRESS_FIELD_MASK,
  BLS12_381_R,
  EMPTY_TREE_ROOT,
  MIN_CREATE_JETTON_POOL_FEE,
  MIN_CREATE_TON_POOL_FEE,
  MIN_DEPOSIT_VALUE,
  MIN_INIT_WALLET_BINDING_VALUE,
  MIN_POOL_CONFIRMATION_VALUE,
  MIN_WITHDRAW_GAS,
  MIN_JETTON_WITHDRAW_GAS,
  FACTORY_TON_RESERVE,
  POOL_TON_RESERVE,
  LEGACY_POOL_CODE_HASHES,
  LEGACY_TON_POOL_CODE_HASHES,
  RECIPIENT_FIELD_DOMAIN,
  RELAYER_REIMBURSEMENT,
  SECURE_POOL_CODE_HASH,
  SECURE_TON_POOL_CODE_HASH,
  TON_POOL_DENOMINATIONS,
  TREE_CAPACITY,
  TREE_DEPTH,
  OP_DEPOSIT,
  OP_WITHDRAW,
  EVENT_DEPOSIT,
  EVENT_TON_WITHDRAW,
  EVENT_WITHDRAW,
} from "../src/constants.js";

describe("constants", () => {
  it("Merkle tree depth and capacity are consistent", () => {
    expect(TREE_DEPTH).toBe(20);
    expect(TREE_CAPACITY).toBe(1 << 20);
  });

  it("MIN_DEPOSIT_VALUE is 0.37 TON", () => {
    expect(MIN_DEPOSIT_VALUE).toBe(370_000_000n);
  });

  it("RELAYER_REIMBURSEMENT is 0.30 TON", () => {
    expect(RELAYER_REIMBURSEMENT).toBe(300_000_000n);
  });

  it("POOL_TON_RESERVE is 0.05 TON", () => {
    expect(POOL_TON_RESERVE).toBe(50_000_000n);
  });

  it("ADDRESS_FIELD_MASK is exactly 248 bits", () => {
    expect(ADDRESS_FIELD_MASK).toEqual((1n << 248n) - 1n);
    expect(ADDRESS_FIELD_MASK + 1n).toEqual(1n << 248n);
  });

  it("uses the canonical recipient-binding domain", () => {
    expect(RECIPIENT_FIELD_DOMAIN).toEqual(0x5a4b5201);
  });

  it("freezes the exact Pool code-hash allowlists", () => {
    expect(SECURE_POOL_CODE_HASH).toBe(
      "51cd5b3ec01beb28a843d30ecf60ea998d1107342a214969ae72047f1eb82dec",
    );
    expect(SECURE_TON_POOL_CODE_HASH).toBe(
      "fde119db0060a01c0a00adc307ec98a2bf5b734ca7ef45e886c9ca2cce642aa3",
    );
    expect(LEGACY_POOL_CODE_HASHES).toEqual([
      "caca8420450e7ae086462cdd7ce32fcbb1c5650151f1606003515b598bcc26db",
    ]);
    expect(LEGACY_TON_POOL_CODE_HASHES).toEqual([
      "057bf7a3006b61bdcc8b77b1264f3b473ff2fec0181de478059eb0d40ecd9d78",
    ]);
    expect(Object.isFrozen(LEGACY_POOL_CODE_HASHES)).toBe(true);
    expect(Object.isFrozen(LEGACY_TON_POOL_CODE_HASHES)).toBe(true);
  });

  it("BLS12-381 scalar field order matches the verifier", () => {
    expect(BLS12_381_R).toBe(
      0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n,
    );
  });

  it("freezes the 1M sparse message and event ABI", () => {
    expect(OP_DEPOSIT).toBe(0xd6e05112);
    expect(OP_WITHDRAW).toBe(0x4b6f0b51);
    expect(EVENT_DEPOSIT).toBe(0x00de9052);
    expect(EVENT_TON_WITHDRAW).toBe(0x00717d3b);
    expect(EVENT_WITHDRAW).toBe(0x00717d3c);
  });

  it("factory runway and create floor mirror the contract", () => {
    expect(FACTORY_TON_RESERVE).toBe(370_000_000n);
    expect(MIN_CREATE_JETTON_POOL_FEE).toBe(450_000_000n);
    expect(MIN_CREATE_TON_POOL_FEE).toBe(450_000_000n);
  });

  it("wallet-binding trigger budgets mirror both Pool branches", () => {
    expect(MIN_INIT_WALLET_BINDING_VALUE).toBe(60_000_000n);
    expect(MIN_POOL_CONFIRMATION_VALUE).toBe(20_000_000n);
  });

  it("MIN_WITHDRAW_GAS is 0.10 TON", () => {
    expect(MIN_WITHDRAW_GAS).toBe(100_000_000n);
    expect(MIN_JETTON_WITHDRAW_GAS).toBe(250_000_000n);
  });

  it("EMPTY_TREE_ROOT matches the on-chain initializer", () => {
    expect(EMPTY_TREE_ROOT).toBe(
      0x276b3bddf0aaccd173fcb1b7d167d34d10680f45f6ed6363ab7ce2096874e0b3n,
    );
  });

  it("TON pool denominations are 10/100/1000/10000 TON in nanoTON", () => {
    expect(TON_POOL_DENOMINATIONS).toEqual([
      10_000_000_000n,
      100_000_000_000n,
      1_000_000_000_000n,
      10_000_000_000_000n,
    ]);
  });
});
