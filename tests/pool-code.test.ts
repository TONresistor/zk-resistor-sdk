import { beginCell, Cell } from "@ton/core";
import { describe, expect, it } from "vitest";
import {
  LEGACY_POOL_CODE_HASHES,
  LEGACY_TON_POOL_CODE_HASHES,
  SECURE_POOL_CODE_HASH,
  SECURE_TON_POOL_CODE_HASH,
} from "../src/constants.js";
import {
  assertAccountPoolCodeCompatible,
  assertPoolCodeHashCompatible,
  poolCodeHashFromBoc,
} from "../src/pool-code.js";
import {
  LEGACY_POOL_CODE_BOC,
  LEGACY_TON_POOL_CODE_BOC,
  SECURE_POOL_CODE_BOC,
  SECURE_TON_POOL_CODE_BOC,
} from "./fixtures/pool-code-bocs.js";

describe("Pool code-hash preflight", () => {
  it("derives the representation hash from AccountState.code BOC", () => {
    const code = beginCell().storeUint(0x12345678, 32).endCell();
    const boc = code.toBoc().toString("base64");
    expect(poolCodeHashFromBoc(boc)).toBe(code.hash().toString("hex"));
  });

  it("matches all exact secure and proven-legacy Acton artifacts", () => {
    expect(poolCodeHashFromBoc(SECURE_POOL_CODE_BOC))
      .toBe(SECURE_POOL_CODE_HASH);
    expect(poolCodeHashFromBoc(SECURE_TON_POOL_CODE_BOC))
      .toBe(SECURE_TON_POOL_CODE_HASH);
    expect(poolCodeHashFromBoc(LEGACY_POOL_CODE_BOC))
      .toBe(LEGACY_POOL_CODE_HASHES[0]);
    expect(poolCodeHashFromBoc(LEGACY_TON_POOL_CODE_BOC))
      .toBe(LEGACY_TON_POOL_CODE_HASHES[0]);
  });

  it("accepts only matching secure kind and full-address binding", () => {
    expect(() => assertPoolCodeHashCompatible(
      SECURE_POOL_CODE_HASH,
      "jetton",
      "full-address",
    )).not.toThrow();
    expect(() => assertPoolCodeHashCompatible(
      SECURE_TON_POOL_CODE_HASH.toUpperCase(),
      "ton",
      "full-address",
    )).not.toThrow();
    expect(() => assertPoolCodeHashCompatible(
      SECURE_POOL_CODE_HASH,
      "ton",
      "full-address",
    )).toThrow(/kind mismatch/);
    expect(() => assertPoolCodeHashCompatible(
      SECURE_TON_POOL_CODE_HASH,
      "ton",
      "legacy-low248",
    )).toThrow(/binding mismatch/);
  });

  it("accepts only the proven legacy hashes in legacy mode", () => {
    expect(() => assertPoolCodeHashCompatible(
      LEGACY_POOL_CODE_HASHES[0],
      "jetton",
      "legacy-low248",
    )).not.toThrow();
    expect(() => assertPoolCodeHashCompatible(
      LEGACY_TON_POOL_CODE_HASHES[0],
      "ton",
      "legacy-low248",
    )).not.toThrow();
    expect(() => assertPoolCodeHashCompatible(
      LEGACY_POOL_CODE_HASHES[0],
      "jetton",
      "full-address",
    )).toThrow(/binding mismatch/);
  });

  it("fails closed for unproven legacy hashes", () => {
    expect(() => assertPoolCodeHashCompatible(
      "5a9b2bf61f99265aab9d54624d54bab2e2786edb09f9007fafaf758668d23e0d",
      "jetton",
      "legacy-low248",
    )).toThrow(/Unknown Pool code hash/);
    expect(() => assertPoolCodeHashCompatible(
      "0229067cfd24b3d82a767527fedd24fb0a48b1acbb0e543fd72a1225712230fc",
      "ton",
      "legacy-low248",
    )).toThrow(/Unknown Pool code hash/);
  });

  it("rejects absent and malformed AccountState.code", () => {
    expect(() => assertAccountPoolCodeCompatible(
      { status: "active" },
      "ton",
      "full-address",
    )).toThrow(/code is unavailable/);
    expect(() => assertAccountPoolCodeCompatible(
      { status: "active", code: "not-a-boc" },
      "ton",
      "full-address",
    )).toThrow(/malformed code BOC/);

    const exoticCode = beginCell()
      .storeUint(2, 8)
      .storeUint(0, 256)
      .endCell({ exotic: true })
      .toBoc()
      .toString("base64");
    expect(() => poolCodeHashFromBoc(exoticCode))
      .toThrow(/only ordinary Cells/);

    const nestedExoticCode = beginCell()
      .storeRef(Cell.fromBase64(exoticCode))
      .endCell()
      .toBoc()
      .toString("base64");
    expect(() => poolCodeHashFromBoc(nestedExoticCode))
      .toThrow(/only ordinary Cells/);
  });
});
