import { describe, it, expect } from "vitest";
import { Address, beginCell } from "@ton/core";
import { parseJettonPoolStorage, parseTonPoolStorage } from "../src/storage.js";

// Real on-chain storage cell of the mainnet KITO/1000 jetton pool
// EQDLR324LQ9d9Wj6xYFFb3gTcAkUBM_Sny-osgBhXYI_rM0i, captured 2026-05-21.
const KITO_POOL_DATA =
  "te6cckECCgEAAWIAAkuAFUtmvgPyd7LYj3LGi+BIC8GBjUfRYiMxAJOXs/NeyDQoI8NGAQECAJGAEkWWqh5U7CJUyoU1EUp2L1Yq/OafMhwLYFSFR5RLR37wAp3ILyD3je46+Q4u02ClLTPzTGDPYIUpuqN4m8aL8dYhejUpRAAgA0kAAAACW/j/yw7DmXXJ8sFGlRU6nrP8u4I2BckHXIBZ11eQ+gnwAwQFAgPPwAYHAEOgDgsNciwvVlvqXmQT+ASqF9vmlqRezSCJyiUk+dmeUGHYAgFICAkAQRx2qbybxq0st8E6pb0WK+2Hvbb20qJDs+hbF7DIt22R4ABBFv4/8sOw5l1yfLBRpUVOp6z/LuCNgXJB1yAWddXkPoJgAEq/qh7W71VPRk2CliVlM6TNwFC6bvzE+xw9i1JJBvXjERAAAAAAAEq/gU6BwOD7LGUavvVpZ6fusYgfqEqbo7FHlPT+Fqg757sAAAABXluAQA==";

describe("parseJettonPoolStorage", () => {
  it("decodes a real on-chain jetton pool storage cell", () => {
    const s = parseJettonPoolStorage(KITO_POOL_DATA);
    expect(s.jettonMaster).toBe(
      "EQCSLLVQ8qdhEqZUKaiKU7F6sVfnNPmQ4FsCpCo8olo795LP",
    );
    expect(s.factory).toBe(
      "EQCncgvIPeN7jr5Di7TYKUtM_NMYM9ghSm6o3ibxovx1iGPu",
    );
    expect(s.denomination).toBe(1_000_000_000_000n);
    expect(s.jettonWallet).toBe(
      "EQCqWzXwH5O9lsR7ljRfAkBeDAxqPosRGYgEnL2fmvZBoeJS",
    );
    expect(s.relayerReserve).toBe(300_000_000n);
    expect(s.nextIndex).toBe(2);
    expect(s.currentRoot).toBe(
      0x5bf8ffcb0ec39975c9f2c14695153a9eb3fcbb823605c9075c8059d75790fa09n,
    );
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
