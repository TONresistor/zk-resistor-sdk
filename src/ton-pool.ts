import type { Client } from "./client.js";
import { parseTonPoolStorage } from "./storage.js";
import type { TonPoolState } from "./types.js";

export { fetchDepositCommitments } from "./pool.js";

export async function readState(
  client: Client,
  poolAddress: string,
): Promise<TonPoolState> {
  const acc = await client.getAccountState(poolAddress);
  if (acc.status !== "active" || !acc.data) {
    throw new Error(
      `TON pool ${poolAddress} is not active (status: ${acc.status}).`,
    );
  }
  const s = parseTonPoolStorage(acc.data);
  return {
    currentRoot: s.currentRoot,
    nextIndex: s.nextIndex,
    denomination: s.denomination,
    pendingWithdrawTon: s.pendingWithdrawTon,
  };
}
