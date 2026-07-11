import { Cell } from "@ton/core";
import {
  LEGACY_POOL_CODE_HASHES,
  LEGACY_TON_POOL_CODE_HASHES,
  SECURE_POOL_CODE_HASH,
  SECURE_TON_POOL_CODE_HASH,
} from "./constants.js";
import type { AccountState } from "./client.js";

export type PoolCodeKind = "jetton" | "ton";
export type PoolCodeRecipientBinding = "full-address" | "legacy-low248";

interface KnownPoolCode {
  kind: PoolCodeKind;
  recipientBinding: PoolCodeRecipientBinding;
}

const KNOWN_POOL_CODE_ENTRIES: Array<readonly [string, KnownPoolCode]> = [
  [
    SECURE_POOL_CODE_HASH,
    { kind: "jetton", recipientBinding: "full-address" },
  ],
  [
    SECURE_TON_POOL_CODE_HASH,
    { kind: "ton", recipientBinding: "full-address" },
  ],
  ...LEGACY_POOL_CODE_HASHES.map((hash) => [
    hash,
    { kind: "jetton", recipientBinding: "legacy-low248" },
  ] as const),
  ...LEGACY_TON_POOL_CODE_HASHES.map((hash) => [
    hash,
    { kind: "ton", recipientBinding: "legacy-low248" },
  ] as const),
];
const KNOWN_POOL_CODES: ReadonlyMap<string, KnownPoolCode> = new Map(
  KNOWN_POOL_CODE_ENTRIES,
);

export function poolCodeHashFromBoc(codeBoc: string): string {
  let code: Cell;
  try {
    code = Cell.fromBase64(codeBoc);
  } catch {
    throw new Error("Pool account returned a malformed code BOC");
  }
  const pending = [code];
  const visited = new Set<Cell>();
  while (pending.length > 0) {
    const current = pending.pop() as Cell;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current.isExotic) {
      throw new Error("Pool account code must contain only ordinary Cells");
    }
    pending.push(...current.refs);
  }
  return code.hash().toString("hex");
}

export function assertPoolCodeHashCompatible(
  codeHash: string,
  expectedKind: PoolCodeKind,
  expectedBinding: PoolCodeRecipientBinding,
): void {
  const normalizedHash = codeHash.toLowerCase();
  const known = KNOWN_POOL_CODES.get(normalizedHash);
  if (!known) {
    throw new Error(`Unknown Pool code hash: ${normalizedHash}`);
  }
  if (known.kind !== expectedKind) {
    throw new Error(
      `Pool code kind mismatch: expected ${expectedKind}, got ${known.kind}`,
    );
  }
  if (known.recipientBinding !== expectedBinding) {
    throw new Error(
      `Pool recipient binding mismatch: requested ${expectedBinding}, ` +
        `code requires ${known.recipientBinding}`,
    );
  }
}

export function assertAccountPoolCodeCompatible(
  account: AccountState,
  expectedKind: PoolCodeKind,
  expectedBinding: PoolCodeRecipientBinding,
): void {
  if (!account.code) {
    throw new Error("Pool account code is unavailable");
  }
  assertPoolCodeHashCompatible(
    poolCodeHashFromBoc(account.code),
    expectedKind,
    expectedBinding,
  );
}
