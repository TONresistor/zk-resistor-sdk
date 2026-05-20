import { Cell } from "@ton/core";
import type { StackEntry } from "./client.js";

export function readBigInt(e: StackEntry): bigint {
  if (e === null) throw new Error("Expected numeric stack entry, got null");
  return BigInt(e);
}

export function readAddrFromB64(b64: StackEntry): string | null {
  if (!b64) return null;
  try {
    return Cell.fromBase64(b64)
      .beginParse()
      .loadAddress()
      .toString({ urlSafe: true, bounceable: true });
  } catch {
    return null;
  }
}
