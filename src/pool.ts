import { Cell } from "@ton/core";
import type { Client } from "./client.js";
import { EVENT_DEPOSIT } from "./constants.js";
import { readBigInt, readAddrFromB64 } from "./stack.js";
import type { DepositEvent, JettonPoolState } from "./types.js";

export async function readState(
  client: Client,
  poolAddress: string,
): Promise<JettonPoolState> {
  const [root, idx, den, jw] = await Promise.all([
    client.runMethod(poolAddress, "currentRoot", []),
    client.runMethod(poolAddress, "nextIndex", []),
    client.runMethod(poolAddress, "denomination", []),
    client.runMethod(poolAddress, "jettonWallet", []),
  ]);
  return {
    currentRoot: readBigInt(root.stack[0] ?? null),
    nextIndex: Number(readBigInt(idx.stack[0] ?? null)),
    denomination: readBigInt(den.stack[0] ?? null),
    jettonWallet: readAddrFromB64(jw.stack[0] ?? null),
  };
}

export async function fetchDepositCommitments(
  client: Client,
  poolAddress: string,
  limit = 256,
): Promise<DepositEvent[]> {
  const res = await client.getTransactions(poolAddress, limit);
  const events: DepositEvent[] = [];
  for (const tx of res.transactions ?? []) {
    for (const out of tx.out_msgs ?? []) {
      if (!out.body) continue;
      try {
        const cs = Cell.fromBase64(out.body).beginParse();
        // Event body: 24-bit prefix, leafIndex:u32, commitment:u256,
        // newRoot:u256, fromUser:address.
        if (cs.remainingBits < 24 + 32 + 256 + 256) continue;
        if (cs.loadUint(24) !== EVENT_DEPOSIT) continue;
        const leafIndex = cs.loadUint(32);
        const commitment = cs.loadUintBig(256);
        const newRoot = cs.loadUintBig(256);
        const fromUser = cs
          .loadAddress()
          .toString({ urlSafe: true, bounceable: true });
        events.push({ leafIndex, commitment, newRoot, fromUser });
      } catch {
        // skip malformed bodies
      }
    }
  }
  return events.sort((a, b) => a.leafIndex - b.leafIndex);
}
