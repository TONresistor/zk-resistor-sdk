import type { Client } from "./client.js";
import { readBigInt } from "./stack.js";
import type { TonPoolState } from "./types.js";

export { fetchDepositCommitments } from "./pool.js";

export async function readState(
  client: Client,
  poolAddress: string,
): Promise<TonPoolState> {
  const [root, idx, den, locked] = await Promise.all([
    client.runMethod(poolAddress, "currentRoot", []),
    client.runMethod(poolAddress, "nextIndex", []),
    client.runMethod(poolAddress, "denomination", []),
    client.runMethod(poolAddress, "pendingWithdrawTon", []),
  ]);
  return {
    currentRoot: readBigInt(root.stack[0] ?? null),
    nextIndex: Number(readBigInt(idx.stack[0] ?? null)),
    denomination: readBigInt(den.stack[0] ?? null),
    pendingWithdrawTon: readBigInt(locked.stack[0] ?? null),
  };
}
