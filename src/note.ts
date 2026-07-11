import { Address, beginCell } from "@ton/core";
import {
  ADDRESS_FIELD_MASK,
  RECIPIENT_FIELD_DOMAIN,
  TREE_CAPACITY,
} from "./constants.js";
import type { Note } from "./types.js";

const NOTE_PREFIX = "zkresistor:";

function isValidAsset(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function generateSecrets(): { nullifier: bigint; secret: bigint } {
  const buf = new Uint8Array(62);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    throw new Error(
      "No secure random source available. Run in a browser or Node >= 19.",
    );
  }
  return {
    nullifier: bytesToField(buf.slice(0, 31)),
    secret: bytesToField(buf.slice(31, 62)),
  };
}

export function makeNote(opts: {
  asset: string;
  denominationUnits: bigint;
  leafIndex: number;
  nullifier: bigint;
  secret: bigint;
  poolAddress: string;
  poolKind: "jetton" | "ton";
}): Note {
  return { ...opts };
}

export function serializeNote(note: Note): string {
  if (!isValidAsset(note.asset)) {
    throw new Error("note requires a valid asset label");
  }
  if (note.denominationUnits <= 0n) {
    throw new RangeError("note denominationUnits must be positive");
  }
  if (
    !Number.isSafeInteger(note.leafIndex) ||
    note.leafIndex < 0 ||
    note.leafIndex >= TREE_CAPACITY
  ) {
    throw new RangeError("note leafIndex is outside the depth-20 tree");
  }
  if (note.nullifier < 0n || note.nullifier > ADDRESS_FIELD_MASK) {
    throw new RangeError("note nullifier must fit in 248 bits");
  }
  if (note.secret < 0n || note.secret > ADDRESS_FIELD_MASK) {
    throw new RangeError("note secret must fit in 248 bits");
  }
  if (note.poolKind !== "jetton" && note.poolKind !== "ton") {
    throw new Error("note requires a valid poolKind");
  }
  const poolAddress = Address.parse(note.poolAddress).toString({
    urlSafe: true,
    bounceable: true,
  });
  return NOTE_PREFIX + encodeURIComponent(JSON.stringify({
    asset: note.asset,
    denominationUnits: note.denominationUnits.toString(),
    leafIndex: note.leafIndex,
    nullifier: note.nullifier.toString(16),
    secret: note.secret.toString(16),
    poolAddress,
    poolKind: note.poolKind,
  }));
}

export function parseNote(raw: string): Note | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(NOTE_PREFIX)) return null;
  try {
    const value = JSON.parse(
      decodeURIComponent(trimmed.slice(NOTE_PREFIX.length)),
    ) as Record<string, unknown>;
    if (
      !isValidAsset(value.asset) ||
      typeof value.denominationUnits !== "string" ||
      !/^[1-9]\d*$/.test(value.denominationUnits) ||
      typeof value.leafIndex !== "number" ||
      !Number.isSafeInteger(value.leafIndex) ||
      value.leafIndex < 0 ||
      value.leafIndex >= TREE_CAPACITY ||
      typeof value.nullifier !== "string" ||
      !/^[0-9a-f]+$/i.test(value.nullifier) ||
      typeof value.secret !== "string" ||
      !/^[0-9a-f]+$/i.test(value.secret) ||
      typeof value.poolAddress !== "string" ||
      (value.poolKind !== "jetton" && value.poolKind !== "ton")
    ) {
      return null;
    }
    const nullifier = BigInt(`0x${value.nullifier}`);
    const secret = BigInt(`0x${value.secret}`);
    if (nullifier > ADDRESS_FIELD_MASK || secret > ADDRESS_FIELD_MASK) {
      return null;
    }
    const poolAddress = Address.parse(value.poolAddress).toString({
      urlSafe: true,
      bounceable: true,
    });
    return {
      asset: value.asset,
      denominationUnits: BigInt(value.denominationUnits),
      leafIndex: value.leafIndex,
      nullifier,
      secret,
      poolAddress,
      poolKind: value.poolKind,
    };
  } catch {
    return null;
  }
}

/**
 * Derives the proof-bound recipient field from the complete canonical address.
 * Bare 32-byte hashes are interpreted as basechain account hashes.
 */
export function addressToField(input: Address | string | Uint8Array): bigint {
  const { accountHash, workchain } = parseAddressIdentity(input);
  const digest = beginCell()
    .storeUint(RECIPIENT_FIELD_DOMAIN, 32)
    .storeInt(workchain, 32)
    .storeUint(bytesToUint(accountHash), 256)
    .endCell()
    .hash();
  const field = bytesToField(digest);
  if (field === 0n) {
    throw new Error("Recipient address maps to the zero field element");
  }
  return field;
}

/**
 * @deprecated Compatibility only for Pools deployed with the legacy low-248
 * recipient binding. Keep the proof private and self-broadcast the withdrawal.
 */
export function legacyAddressToField(
  input: Address | string | Uint8Array,
): bigint {
  return bytesToField(parseAddressIdentity(input).accountHash);
}

function parseAddressIdentity(
  input: Address | string | Uint8Array,
): { accountHash: Uint8Array; workchain: number } {
  let accountHash: Uint8Array;
  let workchain = 0;
  if (input instanceof Address) {
    accountHash = new Uint8Array(input.hash);
    workchain = input.workChain;
  } else if (input instanceof Uint8Array) {
    if (input.length !== 32) {
      throw new Error(`Expected 32 address bytes, got ${input.length}`);
    }
    accountHash = input;
  } else if (typeof input === "string") {
    const hex = input.startsWith("0x") ? input.slice(2) : input;
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      accountHash = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        accountHash[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
    } else {
      const address = Address.parse(input);
      accountHash = new Uint8Array(address.hash);
      workchain = address.workChain;
    }
  } else {
    throw new Error("addressToField: unsupported input type");
  }
  return { accountHash, workchain };
}

function bytesToField(bytes: Uint8Array): bigint {
  return bytesToUint(bytes) & ADDRESS_FIELD_MASK;
}

function bytesToUint(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}
