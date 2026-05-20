import { describe, it, expect } from "vitest";
import { Address } from "@ton/core";
import {
  generateSecrets,
  makeNote,
  serializeNote,
  parseNote,
  addressToField,
} from "../src/note.js";
import { ADDRESS_FIELD_MASK } from "../src/constants.js";

describe("generateSecrets", () => {
  it("returns two distinct 248-bit field elements", () => {
    const { nullifier, secret } = generateSecrets();
    expect(nullifier).not.toEqual(secret);
    expect(nullifier).toBeLessThan(1n << 248n);
    expect(secret).toBeLessThan(1n << 248n);
    expect(nullifier).toBeGreaterThan(0n);
    expect(secret).toBeGreaterThan(0n);
  });

  it("is non-deterministic across calls", () => {
    const a = generateSecrets();
    const b = generateSecrets();
    expect(a.nullifier).not.toEqual(b.nullifier);
    expect(a.secret).not.toEqual(b.secret);
  });
});

describe("note serialize / parse", () => {
  it("round-trips a jetton note", () => {
    const note = makeNote({
      asset: "KITO",
      denominationUnits: 1_000_000_000_000n,
      leafIndex: 42,
      nullifier: 0x1234abcdn,
      secret: 0xdeadbeefn,
    });
    const s = serializeNote(note);
    expect(s).toMatch(/^zkresistor-v1-KITO-1000000000000-42-/);
    const parsed = parseNote(s);
    expect(parsed).toEqual(note);
  });

  it("round-trips a TON note", () => {
    const note = makeNote({
      asset: "TON",
      denominationUnits: 10_000_000_000n,
      leafIndex: 0,
      nullifier: 1n,
      secret: 2n,
    });
    const parsed = parseNote(serializeNote(note));
    expect(parsed).toEqual(note);
  });

  it("returns null for malformed input", () => {
    expect(parseNote("hello world")).toBeNull();
    expect(parseNote("zkresistor-v2-KITO-100-0-aa-bb")).toBeNull();
    expect(parseNote("zkresistor-v1-KITO-not-a-number-0-aa-bb")).toBeNull();
    expect(parseNote("zkresistor-v1-KITO-100-0-not-hex")).toBeNull();
  });
});

describe("addressToField", () => {
  it("derives the same value from Address, friendly string, and raw hex", () => {
    const friendly = "EQB8PZ-Cp6UzydbLvjukx1OQL3LmqeYV-tJ3qVMw_mNYgqow";
    const fromAddress = addressToField(Address.parse(friendly));
    const fromString = addressToField(friendly);
    expect(fromAddress).toEqual(fromString);

    const rawHex =
      "7c3d9f82a7a533c9d6cbbe3ba4c753902f72e6a9e615fad277a95330fe635882";
    const fromHex = addressToField(rawHex);
    expect(fromHex).toEqual(fromAddress);

    expect(fromAddress).toBeLessThan(1n << 248n);
    expect(fromAddress).toEqual(BigInt("0x" + rawHex) & ADDRESS_FIELD_MASK);
  });

  it("accepts a Uint8Array hash directly", () => {
    const hex = "0000000000000000000000000000000000000000000000000000000000000001";
    const bytes = new Uint8Array(32);
    bytes[31] = 1;
    expect(addressToField(bytes)).toEqual(addressToField(hex));
    expect(addressToField(bytes)).toEqual(1n);
  });

  it("throws on malformed hex", () => {
    expect(() => addressToField("dead")).toThrow();
  });
});
