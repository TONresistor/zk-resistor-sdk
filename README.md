# @tonresistor/zkresistor-sdk

TypeScript SDK for ZKResistor privacy pools on TON.

It reads contract state, reconstructs verified Merkle state, generates Groth16
proofs, and builds protocol messages. It never selects a deployment, signs, or
broadcasts; the application supplies the transport, persistence, wallet, and
pool policy.

## Install

Requires Node.js 20.19 or newer.

```bash
npm install @tonresistor/zkresistor-sdk@2.0.1 @ton/core
```

## Select Pools

No Factory is hardcoded. Applications choose a Factory, filter its registry,
or read a known pool directly:

```ts
import { Factory, Pool, TonPool } from "@tonresistor/zkresistor-sdk";

const pools = await Factory.listPools(client, factoryAddress);
const visible = pools.filter((pool) =>
  pool.kind === "jetton" &&
  pool.jettonMaster === selectedJettonMaster &&
  allowedPoolAddresses.has(pool.poolAddress),
);

const jettonState = await Pool.readState(client, jettonPoolAddress);
const tonState = await TonPool.readState(client, tonPoolAddress);
```

For several Factories, call `Factory.listPools()` for each address and retain
the Factory address beside each result.

## Protocol Flows

- `prepareDeposit()` creates the secret note and deposit inputs. Persist
  `prep.noteString` before requesting a wallet signature.
- `finalizeDeposit()` creates the insert proof and message.
- `buildWithdraw()` synchronizes verified state, creates the withdrawal proof,
  and returns a wallet-ready message.
- Message builders return `{ address, value, payload, queryId }`; the SDK never
  handles private keys.

Withdrawals bind the complete recipient address and verify the exact Pool or
TonPool code before proving. `relaySafe` is true only for this binding. Legacy
binding requires explicit `legacySelfBroadcastOnly: true` and must never be
shared with a relayer.

## Local State and Transport

Flows use a caller-provided `Client` and `MerkleStateProvider`.
`LocalMerkleStateProvider` replays successful on-chain events and checks state
against pool heads and sparse roots before exposing paths. Transaction paging
uses exclusive `{ lt, hash }` cursors and external-out messages as events.

The depth-20 tree has `1,048,576` slots. Near full capacity, implement
`MerkleStateProvider` over a compact local transactional database; the bundled
in-memory provider is a reference implementation.

The SDK does not bundle circuit files. Use the finalized ceremony WASM and
proving keys matching the deployed verifier keys.

## Development

```bash
npm ci
npm run lint
npm test
npm run build
```

Contracts: [TONresistor/zk-resistor-contracts](https://github.com/TONresistor/zk-resistor-contracts)

MIT License. See [LICENSE](LICENSE).
