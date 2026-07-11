import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCompactSnapshotChunks,
  encodeCompactSnapshotChunks,
} from "../dist/index.js";

const notes = 1_000_000;
const roots = new Array(256).fill(0n);

function poseidonNodeCount(leaves) {
  let count = 0;
  for (let width = leaves; width > 0; width = Math.ceil(width / 2)) {
    count += width;
    if (width === 1) break;
  }
  return count;
}

function* poseidonNodes(leaves) {
  let width = leaves;
  for (let level = 0; width > 0; level += 1) {
    for (let index = 0; index < width; index += 1) {
      yield { level, index, value: BigInt(index + level + 1) };
    }
    if (width === 1) break;
    width = Math.ceil(width / 2);
  }
}

function* sparseLeaves(count, offset) {
  for (let index = 0; index < count; index += 1) {
    const key = BigInt(index + offset);
    yield { key, leafHash: key + 1n };
  }
}

const source = {
  checkpoint: {
    schemaVersion: 1,
    poolAddress: "EQ-1m-benchmark",
    position: { blockSeqno: 1, transactionLt: 1n, eventIndex: 0 },
    nextIndex: notes,
    withdrawalCount: notes,
    currentRoot: 1n,
    commitmentSeenRoots: roots,
    nullifierSpentRoots: roots,
  },
  poseidonNodeCount: poseidonNodeCount(notes),
  poseidonNodes: poseidonNodes(notes),
  commitmentLeafCount: notes,
  commitmentLeaves: sparseLeaves(notes, 1),
  nullifierLeafCount: notes,
  nullifierLeaves: sparseLeaves(notes, notes + 1),
};

const path = join(tmpdir(), `zkresistor-compact-${process.pid}.bin`);
const encodeStarted = performance.now();
let bytes = 0;
let chunks = 0;
let peakRss = process.memoryUsage().rss;
try {
  const output = createWriteStream(path);
  for (const chunk of encodeCompactSnapshotChunks(source)) {
    bytes += chunk.length;
    chunks += 1;
    if (!output.write(chunk)) await once(output, "drain");
    if ((chunks & 63) === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  output.end();
  await once(output, "close");
  const encodeSeconds = (performance.now() - encodeStarted) / 1000;

  const counts = { poseidon: 0, commitments: 0, nullifiers: 0 };
  const decodeStarted = performance.now();
  await decodeCompactSnapshotChunks(createReadStream(path), {
    begin() {},
    poseidonNode() { counts.poseidon += 1; },
    sparseLeaf(setId) { counts[`${setId}s`] += 1; },
    end() {},
  });
  const decodeSeconds = (performance.now() - decodeStarted) / 1000;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (
    counts.poseidon !== source.poseidonNodeCount ||
    counts.commitments !== notes ||
    counts.nullifiers !== notes
  ) throw new Error("decoded record counts do not match the 1M fixture");
  console.log(JSON.stringify({
    notes,
    poseidonNodes: source.poseidonNodeCount,
    bytes,
    chunks,
    encodeSeconds: Number(encodeSeconds.toFixed(3)),
    decodeSeconds: Number(decodeSeconds.toFixed(3)),
    encodeMiBPerSecond: Number((bytes / 1048576 / encodeSeconds).toFixed(2)),
    decodeMiBPerSecond: Number((bytes / 1048576 / decodeSeconds).toFixed(2)),
    peakRssMiB: Number((peakRss / 1048576).toFixed(1)),
    poseidonHashesComputed: 0,
    decoded: counts,
  }, null, 2));
} finally {
  await rm(path, { force: true });
}
