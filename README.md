# @tonresistor/zkresistor-sdk

TypeScript SDK for ZKResistor privacy pools on TON.

It reads contracts, reconstructs verified Merkle state, generates Groth16
proofs, and builds protocol messages. The application chooses its deployment,
transport, persistence, wallet, and Pool policy. The SDK never handles private
keys or broadcasts transactions.

## Install

Requires Node.js 20.19 or newer.

```bash
npm install @tonresistor/zkresistor-sdk@2.0.1 @ton/core
```

## Integrate

Applications provide:

- a `Client` for account state, getters, and transaction history;
- a `MerkleStateProvider` for verified paths and sparse-set witnesses;
- the final ceremony WASM and ZKeys matching the deployed verifier;
- a wallet or backend to sign and broadcast returned messages.

No Factory is hardcoded. Use one Factory, combine several, filter their Pools,
or read a known Pool directly.

```ts
import { Factory, Pool, TonPool } from "@tonresistor/zkresistor-sdk";

const pools = await Factory.listPools(client, factoryAddress, {
  resolveJettonMeta,
});
const visible = pools.filter((pool) => allowedPools.has(pool.poolAddress));

const jettonState = await Pool.readState(client, jettonPoolAddress);
const gramState = await TonPool.readState(client, gramPoolAddress);
```

The caller-provided `Client` implements `getAccountState`, `runMethod`, and
paginated `getTransactions`. It may use a local or public liteserver, an RPC
provider, or an indexer exposing complete canonical transaction data.

## State

`LocalMerkleStateProvider` replays successful on-chain Pool events and verifies
the result against Pool heads and sparse roots.

```ts
import {
  LocalMerkleStateProvider,
  Pool,
  createClientEventSource,
  createPoseidon2,
} from "@tonresistor/zkresistor-sdk";

const poseidon2 = createPoseidon2(poseidonWasm);
const stateProvider = await LocalMerkleStateProvider.create({
  poolAddress,
  poseidon2,
  source: createClientEventSource(client),
  chain: Pool.createStateChainReader(client),
  store,
});
```

Use `TonPool.createStateChainReader()` for a GRAM Pool. Persistence is optional;
implement `MerkleStateSnapshotStore` for compact snapshots and verified delta
journals. Large Pools should use a transactional local database rather than the
in-memory reference implementation.

## Deposit

`prepareDeposit()` generates the Secret Note and synchronizes state.
`finalizeDeposit()` creates the Insert proof and wallet-ready message.

```ts
const prep = await prepareDeposit(client, depositOptions);

// Require the user to retain prep.noteString before continuing.
const plan = await finalizeDeposit(client, {
  prep,
  poseidon2,
  insertProver,
});

await wallet.send(plan.message);
```

If Pool state changes between both phases, discard the preparation and start
again. Never broadcast a deposit before the user has retained its Secret Note.

## Withdraw

`buildWithdraw()` verifies Pool code and state, generates the Withdraw proof,
and returns a wallet-ready message.

```ts
const note = parseNote(noteString);
if (note === null) throw new Error("Invalid Secret Note");

const plan = await buildWithdraw(client, {
  kind: note.poolKind,
  note,
  poolAddress: note.poolAddress,
  recipientAddress,
  stateProvider,
  poseidon2,
  withdrawProver,
});

await wallet.send(plan.message);
```

The default proof binds the complete workchain-0 recipient. Share a withdrawal
with a relayer only when `plan.relaySafe` is `true`. If sparse state changes
before submission, `plan.refreshSparseProof()` refreshes the message without
regenerating the Groth16 proof.

## Security

- A Secret Note is a bearer secret and has no recovery path.
- Never send notes or note-derived values to analytics.
- Pin the network, intended Factory, Pool code hashes, and circuit artifacts.
- Verify remote snapshots against on-chain Pool state before using them.
- Token metadata and visible Pool selection remain application policy.
- The SDK builds messages but never stores mnemonics, signs, or broadcasts.

The protocol hides the deposit-to-withdrawal link. Pool choice, denomination,
timing, commitments, nullifier hashes, and recipient addresses remain public on
TON.

## API

- `Factory`, `Pool`, `TonPool`: discovery, state, getters, and proof previews.
- `prepareDeposit`, `finalizeDeposit`, `buildWithdraw`: complete protocol flows.
- `generateSecrets`, `serializeNote`, `parseNote`: Secret Note lifecycle.
- `createPoseidon2`, `createSnarkjsProver`: proof dependencies.
- Message builders: Factory, deposit, withdrawal, and wallet binding.
- State APIs: local replay, sparse sets, snapshots, and event sources.

The TypeScript declarations shipped in `dist/` define the complete public API.
Circuit files are not bundled; applications must supply and verify the finalized
ceremony artifacts.

## Development

```bash
npm ci
npm run lint
npm test
npm run build
```

`npm run bench:snapshot-1m` optionally measures compact-snapshot streaming with
one million synthetic entries. It is not a proof-generation or full-SDK
benchmark and is not a release gate.

Contracts: [TONresistor/zk-resistor-contracts](https://github.com/TONresistor/zk-resistor-contracts)

MIT License. See [LICENSE](LICENSE).
