import { describe, it, expect } from "vitest";
import { Address, beginCell } from "@ton/core";
import { parseJettonPoolStorage, parseTonPoolStorage } from "../src/storage.js";

describe("parseJettonPoolStorage", () => {
  it("decodes the bound wallet and withdrawal count exactly", () => {
    const jettonMaster = Address.parseRaw(`0:${"11".repeat(32)}`);
    const factory = Address.parseRaw(`0:${"22".repeat(32)}`);
    const wallet = Address.parseRaw(`0:${"33".repeat(32)}`);
    const identity = beginCell()
      .storeAddress(jettonMaster)
      .storeAddress(factory)
      .storeCoins(1_000n)
      .endCell();
    const merkle = beginCell().storeUint(7, 32).storeUint(8n, 256).endCell();
    const data = beginCell()
      .storeRef(identity)
      .storeAddress(wallet)
      .storeCoins(300_000_000n)
      .storeRef(merkle)
      .storeUint(11, 32)
      .endCell();
    const parsed = parseJettonPoolStorage(data.toBoc().toString("base64"));
    expect(parsed.jettonMaster).toBe(jettonMaster.toString({ urlSafe: true, bounceable: true }));
    expect(parsed.jettonWallet).toBe(wallet.toString({ urlSafe: true, bounceable: true }));
    expect(parsed.relayerReserve).toBe(300_000_000n);
    expect(parsed.withdrawalCount).toBe(11);
    expect(parsed.nextIndex).toBe(7);
    expect(parsed.currentRoot).toBe(8n);
  });
});

describe("parseTonPoolStorage", () => {
  it("round-trips a TON pool storage cell", () => {
    const factory = "EQCncgvIPeN7jr5Di7TYKUtM_NMYM9ghSm6o3ibxovx1iGPu";
    const identity = beginCell()
      .storeAddress(Address.parse(factory))
      .storeCoins(100_000_000_000n)
      .endCell();
    const merkle = beginCell()
      .storeUint(7, 32)
      .storeUint(0x1234abcdn, 256)
      .storeBit(false)
      .storeBit(false)
      .storeBit(false)
      .endCell();
    const data = beginCell()
      .storeRef(identity)
      .storeRef(merkle)
      .storeCoins(300_000_000n)
      .storeCoins(700_000_000_000n)
      .endCell();

    const s = parseTonPoolStorage(data.toBoc().toString("base64"));
    expect(s.factory).toBe(factory);
    expect(s.denomination).toBe(100_000_000_000n);
    expect(s.relayerReserve).toBe(300_000_000n);
    expect(s.pendingWithdrawTon).toBe(700_000_000_000n);
    expect(s.nextIndex).toBe(7);
    expect(s.currentRoot).toBe(0x1234abcdn);
  });
});
