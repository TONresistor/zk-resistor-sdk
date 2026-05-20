import { Address } from "@ton/core";
import { ADDRESS_FIELD_MASK } from "./constants.js";
import type { Note } from "./types.js";

const NOTE_PREFIX = "zkresistor-v1";

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
}): Note {
  return { ...opts };
}

export function serializeNote(note: Note): string {
  return [
    NOTE_PREFIX,
    note.asset,
    note.denominationUnits.toString(),
    note.leafIndex.toString(),
    note.nullifier.toString(16),
    note.secret.toString(16),
  ].join("-");
}

export function parseNote(raw: string): Note | null {
  const m = raw
    .trim()
    .match(/^zkresistor-v1-([A-Z0-9]+)-(\d+)-(\d+)-([0-9a-f]+)-([0-9a-f]+)$/i);
  if (!m) return null;
  const [, asset, denomUnits, leafIndex, nullHex, secHex] = m;
  if (!asset || !denomUnits || !leafIndex || !nullHex || !secHex) return null;
  return {
    asset,
    denominationUnits: BigInt(denomUnits),
    leafIndex: parseInt(leafIndex, 10),
    nullifier: BigInt("0x" + nullHex),
    secret: BigInt("0x" + secHex),
  };
}

export function addressToField(input: Address | string | Uint8Array): bigint {
  let bytes: Uint8Array;
  if (input instanceof Address) {
    bytes = new Uint8Array(input.hash);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else if (typeof input === "string") {
    if (input.startsWith("EQ") || input.startsWith("UQ")) {
      bytes = new Uint8Array(Address.parse(input).hash);
    } else {
      const hex = input.startsWith("0x") ? input.slice(2) : input;
      if (hex.length !== 64) {
        throw new Error(`Expected 32-byte hex hash, got ${hex.length} chars`);
      }
      bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
    }
  } else {
    throw new Error("addressToField: unsupported input type");
  }

  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v & ADDRESS_FIELD_MASK;
}

function bytesToField(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v & ADDRESS_FIELD_MASK;
}
