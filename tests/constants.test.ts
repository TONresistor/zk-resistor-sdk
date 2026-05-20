import { describe, it, expect } from "vitest";
import {
  ADDRESS_FIELD_MASK,
  EMPTY_TREE_ROOT,
  MIN_CREATE_POOL_FEE,
  MIN_DEPOSIT_VALUE,
  MIN_WITHDRAW_GAS,
  POOL_TON_RESERVE,
  RELAYER_REIMBURSEMENT,
  TON_POOL_DENOMINATIONS,
  TREE_CAPACITY,
  TREE_DEPTH,
} from "../src/constants.js";

describe("constants", () => {
  it("Merkle tree depth and capacity are consistent", () => {
    expect(TREE_DEPTH).toBe(20);
    expect(TREE_CAPACITY).toBe(1 << 20);
  });

  it("MIN_DEPOSIT_VALUE is 0.32 TON", () => {
    expect(MIN_DEPOSIT_VALUE).toBe(320_000_000n);
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

  it("MIN_CREATE_POOL_FEE is 0.20 TON", () => {
    expect(MIN_CREATE_POOL_FEE).toBe(200_000_000n);
  });

  it("MIN_WITHDRAW_GAS is 0.10 TON", () => {
    expect(MIN_WITHDRAW_GAS).toBe(100_000_000n);
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
