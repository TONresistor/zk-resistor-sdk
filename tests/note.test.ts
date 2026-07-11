import { describe, expect, it } from "vitest";
import { Address, beginCell } from "@ton/core";
import {
  addressToField,
  generateSecrets,
  legacyAddressToField,
  makeNote,
  parseNote,
  serializeNote,
} from "../src/note.js";
import {
  ADDRESS_FIELD_MASK,
  RECIPIENT_FIELD_DOMAIN,
  TREE_CAPACITY,
} from "../src/constants.js";

const POOL = "EQB8PZ-Cp6UzydbLvjukx1OQL3LmqeYV-tJ3qVMw_mNYgqow";

function mirrorRecipientField(workchain: number, accountHashHex: string): bigint {
  const digest = beginCell()
    .storeUint(RECIPIENT_FIELD_DOMAIN, 32)
    .storeInt(workchain, 32)
    .storeUint(BigInt("0x" + accountHashHex), 256)
    .endCell()
    .hash();
  return BigInt("0x" + digest.toString("hex")) & ADDRESS_FIELD_MASK;
}

function note(overrides: Partial<ReturnType<typeof makeNote>> = {}) {
  return makeNote({
    asset: "TON",
    denominationUnits: 10_000_000_000n,
    leafIndex: 0,
    nullifier: 1n,
    secret: 2n,
    poolAddress: POOL,
    poolKind: "ton",
    ...overrides,
  });
}

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

describe("note serialization", () => {
  it("round-trips the single pool-bound note format", () => {
    const value = note({
      asset: "ZOICH",
      denominationUnits: 1_000_000_000_000n,
      leafIndex: 42,
      nullifier: 0x1234abcdn,
      secret: 0xdeadbeefn,
      poolKind: "jetton",
    });
    const serialized = serializeNote(value);
    expect(serialized).toMatch(/^zkresistor:%7B/);
    expect(parseNote(serialized)).toEqual({
      ...value,
      poolAddress: Address.parse(POOL).toString({
        urlSafe: true,
        bounceable: true,
      }),
    });
  });

  it("rejects obsolete and malformed formats", () => {
    expect(parseNote("hello world")).toBeNull();
    expect(parseNote("zkresistor-old-TON-100-0-aa-bb")).toBeNull();
    expect(parseNote("zkresistor:%7Bbad-json")).toBeNull();
  });

  it("rejects invalid asset, denomination, pool and leaf metadata", () => {
    expect(() => serializeNote(note({ asset: " ZOICH" })))
      .toThrow(/valid asset label/);
    expect(() => serializeNote(note({ denominationUnits: 0n })))
      .toThrow(/positive/);
    expect(() => serializeNote(note({ leafIndex: TREE_CAPACITY })))
      .toThrow(/depth-20 tree/);
    expect(() => serializeNote(note({ poolAddress: "not-an-address" })))
      .toThrow();
  });

  it("enforces the circuit's 248-bit nullifier and secret range", () => {
    expect(parseNote(serializeNote(note({
      nullifier: ADDRESS_FIELD_MASK,
      secret: ADDRESS_FIELD_MASK,
    })))).not.toBeNull();
    expect(() => serializeNote(note({ nullifier: 1n << 248n })))
      .toThrow(/248 bits/);
    expect(() => serializeNote(note({ secret: 1n << 248n })))
      .toThrow(/248 bits/);

    const encoded = "zkresistor:" + encodeURIComponent(JSON.stringify({
      asset: "TON",
      denominationUnits: "1",
      leafIndex: 0,
      nullifier: (1n << 248n).toString(16),
      secret: "2",
      poolAddress: POOL,
      poolKind: "ton",
    }));
    expect(parseNote(encoded)).toBeNull();
  });
});

describe("addressToField", () => {
  it("derives the canonical digest from Address, friendly string, and raw hex", () => {
    const fromAddress = addressToField(Address.parse(POOL));
    const fromString = addressToField(POOL);
    expect(fromAddress).toEqual(fromString);

    const rawHex =
      "7c3d9f82a7a533c9d6cbbe3ba4c753902f72e6a9e615fad277a95330fe635882";
    expect(addressToField(rawHex)).toEqual(fromAddress);
    expect(fromAddress).toBeLessThan(1n << 248n);

    expect(fromAddress).toEqual(mirrorRecipientField(0, rawHex));
    expect(fromAddress).toEqual(
      0xde87c6054755808089480d2d56e766528528068d671b9bed954900a1225b02n,
    );
  });

  it("accepts a Uint8Array hash and rejects malformed hex", () => {
    const bytes = new Uint8Array(32);
    bytes[31] = 1;
    expect(addressToField(bytes)).toEqual(addressToField("0".repeat(63) + "1"));
    expect(() => addressToField("dead")).toThrow();
    expect(() => addressToField("zz".repeat(32))).toThrow();
    expect(() => addressToField(new Uint8Array(31))).toThrow(/32 address bytes/);
    expect(addressToField(Address.parse(POOL).toRawString()))
      .toEqual(addressToField(Address.parse(POOL)));
  });

  it("binds the high byte that the legacy low-248 mapping discarded", () => {
    const low248 =
      "3d9f82a7a533c9d6cbbe3ba4c753902f72e6a9e615fad277a95330fe635882";
    const first = Address.parseRaw(`0:7c${low248}`);
    const second = Address.parseRaw(`0:7d${low248}`);

    expect(BigInt("0x7c" + low248) & ADDRESS_FIELD_MASK)
      .toEqual(BigInt("0x7d" + low248) & ADDRESS_FIELD_MASK);
    expect(addressToField(first)).not.toEqual(addressToField(second));
    expect(addressToField(second)).toEqual(
      0x6c96785d2f69f5d072361899a26c14fb729b7fa613a4a2dc3dd4f519e351e6n,
    );
    expect(legacyAddressToField(first)).toEqual(
      BigInt("0x7c" + low248) & ADDRESS_FIELD_MASK,
    );
    expect(legacyAddressToField(second)).toEqual(legacyAddressToField(first));
  });

  it("separates a canonical field from a crafted legacy alias", () => {
    const canonicalRecipient = Address.parse(POOL);
    const canonicalField = addressToField(canonicalRecipient);
    const aliasHash = "ff" + canonicalField.toString(16).padStart(62, "0");
    const legacyAlias = Address.parseRaw(`0:${aliasHash}`);

    expect(legacyAddressToField(legacyAlias)).toEqual(canonicalField);
    expect(addressToField(legacyAlias)).not.toEqual(canonicalField);
    expect(legacyAlias.equals(canonicalRecipient)).toBe(false);
  });

  it("ignores friendly bounce and test flags, which are not account identity", () => {
    const address = Address.parse(POOL);
    const variants = [
      address.toString({ bounceable: true, testOnly: false }),
      address.toString({ bounceable: false, testOnly: false }),
      address.toString({ bounceable: true, testOnly: true }),
      address.toString({ bounceable: false, testOnly: true }),
    ];

    expect(new Set(variants.map(addressToField)).size).toBe(1);
    expect(new Set(variants.map(legacyAddressToField)).size).toBe(1);
  });

  it("includes the signed workchain in the deterministic mirror", () => {
    const hash = Buffer.from(
      "7c3d9f82a7a533c9d6cbbe3ba4c753902f72e6a9e615fad277a95330fe635882",
      "hex",
    );
    const basechain = new Address(0, hash);
    const masterchain = new Address(-1, hash);

    expect(addressToField(basechain)).not.toEqual(addressToField(masterchain));
    expect(addressToField(masterchain)).toEqual(
      mirrorRecipientField(-1, hash.toString("hex")),
    );
    expect(addressToField(masterchain)).toEqual(
      0xced979e9e7688379030ef03a96d4962b4559306e40c65093d065cae616464en,
    );
  });
});
