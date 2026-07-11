import { Cell } from "@ton/core";
import type { RunMethodArg, RunMethodResult, StackEntry } from "./client.js";

export function assertRunMethodSuccess(
  result: RunMethodResult,
  method: string,
): void {
  if (result.exit_code !== 0 && result.exit_code !== 1) {
    throw new Error(`${method} getter failed with exit code ${result.exit_code}`);
  }
}

export function readBigInt(e: StackEntry): bigint {
  if (e === null) throw new Error("Expected numeric stack entry, got null");
  return BigInt(e);
}

export function readBoolean(e: StackEntry): boolean {
  const value = readBigInt(e);
  if (value === 0n) return false;
  if (value === -1n) return true;
  throw new Error(`Expected TVM boolean stack entry, got ${value}`);
}

export function readUintNumber(
  e: StackEntry,
  bits: number,
  method: string,
): number {
  const value = readBigInt(e);
  const maximum = (1n << BigInt(bits)) - 1n;
  if (value < 0n || value > maximum) {
    throw new RangeError(`${method} getter returned a non-uint${bits} value`);
  }
  return Number(value);
}

export function cellSliceArg(cell: Cell): RunMethodArg {
  return { type: "slice", boc: cell.toBoc().toString("base64") };
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
