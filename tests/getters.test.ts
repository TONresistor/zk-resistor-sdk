import { describe, expect, it, vi } from "vitest";
import { Address, beginCell } from "@ton/core";
import type { Client, RunMethodArg } from "../src/client.js";
import * as Factory from "../src/factory.js";
import * as Pool from "../src/pool.js";
import * as TonPool from "../src/ton-pool.js";

const FACTORY = "EQCncgvIPeN7jr5Di7TYKUtM_NMYM9ghSm6o3ibxovx1iGPu";
const MASTER = "EQCSLLVQ8qdhEqZUKaiKU7F6sVfnNPmQ4FsCpCo8olo795LP";

function addressStack(address: string): string {
  return beginCell()
    .storeAddress(Address.parse(address))
    .endCell()
    .toBoc()
    .toString("base64");
}

function proofCell() {
  return beginCell()
    .storeRef(beginCell().storeBuffer(Buffer.alloc(48)).endCell())
    .storeRef(beginCell().storeBuffer(Buffer.alloc(96)).endCell())
    .storeRef(beginCell().storeBuffer(Buffer.alloc(48)).endCell())
    .endCell();
}

function clientWithExitCode(exitCode: number): Client {
  return {
    async getAccountState() { throw new Error("unused"); },
    async getTransactions() { throw new Error("unused"); },
    runMethod: vi.fn(async () => ({ exit_code: exitCode, stack: ["0"] })),
  };
}

describe("getter exit codes", () => {
  it("rejects non-success exit codes before reading any stack", async () => {
    const client = clientWithExitCode(42);
    const readers = [
      () => Pool.readSparseRoot(client, FACTORY, "commitment", 0),
      () => Pool.readWithdrawalCount(client, FACTORY),
      () => Pool.readRentRunway(client, FACTORY),
      () => Factory.expectedPoolAddress(client, FACTORY, MASTER, 1n),
      () => Factory.poolAddressFor(client, FACTORY, MASTER, 1n),
      () => Factory.expectedTonPoolAddress(client, FACTORY, 10_000_000_000n),
      () => Factory.tonPoolAddressFor(client, FACTORY, 10_000_000_000n),
      () => Factory.poolCount(client, FACTORY),
      () => Factory.tonPoolCount(client, FACTORY),
    ];
    for (const read of readers) {
      await expect(read()).rejects.toThrow(/getter failed with exit code 42/);
    }
  });

  it("accepts both TVM success exit codes", async () => {
    await expect(Pool.readRentRunway(clientWithExitCode(0), FACTORY))
      .resolves.toBe(0n);
    await expect(Pool.readRentRunway(clientWithExitCode(1), FACTORY))
      .resolves.toBe(0n);
  });
});

describe("complete Factory getter surface", () => {
  it("calls and decodes every public Factory getter", async () => {
    const calls: Array<{ method: string; params: readonly RunMethodArg[] }> = [];
    const values: Record<string, string | null> = {
      expectedPoolAddress: addressStack(MASTER),
      poolAddressFor: addressStack(MASTER),
      expectedTonPoolAddress: addressStack(MASTER),
      tonPoolAddressFor: null,
      poolCount: "2",
      tonPoolCount: "3",
      totalPoolCount: "5",
      inFlightCreateCount: "4",
      maxFactoryPools: "4096",
      maxInFlightCreates: "128",
      pendingCreateSender: addressStack(MASTER),
      poolDeploymentPending: "-1",
      tonPoolDeploymentPending: "0",
    };
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async getTransactions() { throw new Error("unused"); },
      async runMethod(_address, method, params) {
        calls.push({ method, params });
        return { exit_code: 0, stack: [values[method] ?? null] };
      },
    };

    await expect(Factory.expectedPoolAddress(client, FACTORY, MASTER, 1n))
      .resolves.toBe(Address.parse(MASTER).toString());
    await expect(Factory.poolAddressFor(client, FACTORY, MASTER, 1n))
      .resolves.toBe(Address.parse(MASTER).toString());
    await expect(Factory.expectedTonPoolAddress(client, FACTORY, 10n))
      .resolves.toBe(Address.parse(MASTER).toString());
    await expect(Factory.tonPoolAddressFor(client, FACTORY, 10n))
      .resolves.toBeNull();
    await expect(Factory.poolCount(client, FACTORY)).resolves.toBe(2);
    await expect(Factory.tonPoolCount(client, FACTORY)).resolves.toBe(3);
    await expect(Factory.totalPoolCount(client, FACTORY)).resolves.toBe(5);
    await expect(Factory.inFlightCreateCount(client, FACTORY)).resolves.toBe(4);
    await expect(Factory.maxFactoryPools(client, FACTORY)).resolves.toBe(4096);
    await expect(Factory.maxInFlightCreates(client, FACTORY)).resolves.toBe(128);
    await expect(Factory.pendingCreateSender(client, FACTORY, MASTER))
      .resolves.toBe(Address.parse(MASTER).toString());
    await expect(Factory.poolDeploymentPending(client, FACTORY, MASTER, 1n))
      .resolves.toBe(true);
    await expect(Factory.tonPoolDeploymentPending(client, FACTORY, 10n))
      .resolves.toBe(false);

    expect(calls.map(({ method }) => method)).toEqual([
      "expectedPoolAddress",
      "poolAddressFor",
      "expectedTonPoolAddress",
      "tonPoolAddressFor",
      "poolCount",
      "tonPoolCount",
      "totalPoolCount",
      "inFlightCreateCount",
      "maxFactoryPools",
      "maxInFlightCreates",
      "pendingCreateSender",
      "poolDeploymentPending",
      "tonPoolDeploymentPending",
    ]);
  });
});

describe("complete Pool getter surface", () => {
  it("calls and decodes every public Jetton Pool getter", async () => {
    const calls: string[] = [];
    const addressMethods = new Set(["jettonMaster", "factory", "jettonWallet"]);
    const boolMethods = new Set(["previewInsertProof", "previewWithdrawProof"]);
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async getTransactions() { throw new Error("unused"); },
      async runMethod(_address, method) {
        calls.push(method);
        return {
          exit_code: 0,
          stack: [addressMethods.has(method)
            ? addressStack(MASTER)
            : boolMethods.has(method) ? "-1" : "20"],
        };
      },
    };

    await expect(Pool.readJettonMaster(client, MASTER)).resolves.toBe(
      Address.parse(MASTER).toString(),
    );
    await expect(Pool.readFactory(client, MASTER)).resolves.toBe(
      Address.parse(MASTER).toString(),
    );
    await expect(Pool.readJettonWallet(client, MASTER)).resolves.toBe(
      Address.parse(MASTER).toString(),
    );
    await expect(Pool.readDenomination(client, MASTER)).resolves.toBe(20n);
    await expect(Pool.readCurrentRoot(client, MASTER)).resolves.toBe(20n);
    await expect(Pool.readNextIndex(client, MASTER)).resolves.toBe(20);
    await expect(Pool.readRelayerReserve(client, MASTER)).resolves.toBe(20n);
    await expect(Pool.readRentRunway(client, MASTER)).resolves.toBe(20n);
    await expect(Pool.readSparseRoot(client, MASTER, "commitment", 0))
      .resolves.toBe(20n);
    await expect(Pool.readWithdrawalCount(client, MASTER)).resolves.toBe(20);
    await expect(Pool.readTreeDepth(client, MASTER)).resolves.toBe(20);
    await expect(Pool.previewInsertProof(client, MASTER, {
      oldRoot: 1n,
      newRoot: 2n,
      commitment: 3n,
      leafIndex: 4,
      proofCell: proofCell(),
    })).resolves.toBe(true);
    await expect(Pool.previewWithdrawProof(client, MASTER, {
      root: 1n,
      nullifierHash: 2n,
      recipientField: 3n,
      proofCell: proofCell(),
    })).resolves.toBe(true);

    expect(calls).toEqual([
      "jettonMaster",
      "factory",
      "jettonWallet",
      "denomination",
      "currentRoot",
      "nextIndex",
      "relayerReserve",
      "rentRunway",
      "sparseRoot",
      "withdrawalCount",
      "treeDepth",
      "previewInsertProof",
      "previewWithdrawProof",
    ]);
  });

  it("encodes Groth16 proof points as three exact slice arguments", async () => {
    const runMethod = vi.fn(async (
      _address: string,
      _method: string,
      params: readonly RunMethodArg[],
    ) => ({ exit_code: 0, stack: ["-1"] }));
    const client = {
      ...clientWithExitCode(0),
      runMethod,
    };
    await Pool.previewInsertProof(client, MASTER, {
      oldRoot: 1n,
      newRoot: 2n,
      commitment: 3n,
      leafIndex: 4,
      proofCell: proofCell(),
    });
    const params = runMethod.mock.calls[0]?.[2];
    expect(params).toHaveLength(7);
    expect(params?.slice(4).every((arg) => typeof arg !== "string"))
      .toBe(true);
  });
});

describe("complete TonPool getter surface", () => {
  it("exposes every native Pool getter", async () => {
    const methods: string[] = [];
    const client: Client = {
      async getAccountState() { throw new Error("unused"); },
      async getTransactions() { throw new Error("unused"); },
      async runMethod(_address, method) {
        methods.push(method);
        return {
          exit_code: 0,
          stack: [method === "factory" ? addressStack(MASTER) : "9"],
        };
      },
    };
    await TonPool.readFactory(client, MASTER);
    await TonPool.readDenomination(client, MASTER);
    await TonPool.readCurrentRoot(client, MASTER);
    await TonPool.readNextIndex(client, MASTER);
    await TonPool.readSparseRoot(client, MASTER, "nullifier", 1);
    await TonPool.readRentRunway(client, MASTER);
    await TonPool.readRelayerReserve(client, MASTER);
    await TonPool.readPendingWithdrawTon(client, MASTER);
    await TonPool.readWithdrawalCount(client, MASTER);
    await TonPool.readTreeDepth(client, MASTER);
    expect(methods).toEqual([
      "factory",
      "denomination",
      "currentRoot",
      "nextIndex",
      "sparseRoot",
      "rentRunway",
      "relayerReserve",
      "pendingWithdrawTon",
      "withdrawalCount",
      "treeDepth",
    ]);
  });
});
