# @tonresistor/zkresistor-sdk

TypeScript SDK for ZKResistor, a trustless ZK privacy pool on TON. It builds the
protocol messages, reads pool state, generates Merkle witnesses, and drives the
deposit and withdraw flows. It is RPC-agnostic (you supply a small `Client`
adapter) and prover-agnostic (snarkjs by default).

The SDK never signs or broadcasts. Every builder returns an
`{ address, value, payload }` triple for your own wallet integration.

- Contracts: https://github.com/TONresistor/zk-resistor-contracts
- App: https://zk.resistance.dog
- License: MIT

## Install

```bash
npm install @tonresistor/zkresistor-sdk @ton/core
```

`@ton/core` is a peer dependency.

## Deposit

```ts
import {
  prepareDeposit,
  finalizeDeposit,
  createPoseidon2,
  createSnarkjsProver,
} from "@tonresistor/zkresistor-sdk";

const poseidon2 = createPoseidon2(hasherWasmBytes);
const insertProver = createSnarkjsProver({
  wasm: "/circuits/insert.wasm",
  zkey: "/circuits/insert_final.zkey",
});

// Phase 1 is instant and local. Show the note to the user before signing.
const prep = await prepareDeposit(client, {
  kind: "jetton",
  poolAddress,
  asset: "KITO",
  denomination: 1_000_000_000_000n,
  userAddress,
  userJettonWallet,
});
console.log("Save this note:", prep.noteString);

// Phase 2 generates the proof and builds the transaction.
const plan = await finalizeDeposit(client, { prep, poseidon2, insertProver });
await wallet.send(plan.message);
```

## Withdraw

```ts
import {
  buildWithdraw,
  parseNote,
  createPoseidon2,
  createSnarkjsProver,
} from "@tonresistor/zkresistor-sdk";

const note = parseNote(savedNoteString);
if (!note) throw new Error("Invalid note");

const withdrawProver = createSnarkjsProver({
  wasm: "/circuits/withdraw.wasm",
  zkey: "/circuits/withdraw_final.zkey",
});

const plan = await buildWithdraw(client, {
  kind: note.asset === "TON" ? "ton" : "jetton",
  note,
  poolAddress,
  recipientAddress,
  poseidon2: createPoseidon2(hasherWasmBytes),
  withdrawProver,
});

await wallet.send(plan.message);
```

The recipient is bound to the proof by construction, so anyone can broadcast the
resulting message. The transaction sender receives the fixed relayer
reimbursement.

## The Client interface

The SDK reads the chain through a small interface you implement once for your
stack (tonutils-bridge, tonapi.io, ton-access, or a raw liteclient):

```ts
interface Client {
  getAccountState(address: string): Promise<AccountState>;
  runMethod(address: string, method: string, params: readonly RunMethodArg[]): Promise<RunMethodResult>;
  getTransactions(address: string, limit: number): Promise<GetTransactionsResult>;
}
```

The factory address is never hardcoded. Pass it explicitly to `Factory.listPools`
and the other factory readers. The current deployment address is in the
contracts repository.

## Circuit artifacts

The SDK does not bundle the ZK artifacts. Three files are needed at runtime,
hosted wherever you choose:

- `hasher.wasm`, the Poseidon BLS12-381 witness calculator.
- `insert.wasm` and `insert_final.zkey`, the Merkle insertion circuit.
- `withdraw.wasm` and `withdraw_final.zkey`, the withdraw membership circuit.

Sources and build scripts are in the contracts repository under `circuits/`.
In a browser, run the prover in a Web Worker so proof generation does not block
the main thread.

The current trusted setup is a solo Powers-of-Tau. A multi-party ceremony is
planned.

## License

MIT, see LICENSE.
