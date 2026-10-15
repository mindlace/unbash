import assert from "node:assert/strict";
import { Bench, type BenchOptions } from "tinybench";
import { workloads } from "./fixtures.ts";
import { loadParser, type Mode, type ParserSpec } from "./parsers.ts";

export type WorkerOptions = {
  parser: ParserSpec;
  group: string;
  mode: Mode;
  timing?: Pick<BenchOptions, "warmupTime" | "time" | "iterations">;
};
export type Measurement = {
  pid: number;
  checksum: number;
  sink: number;
  row: NonNullable<ReturnType<Bench["table"]>[number]>;
};

const options: WorkerOptions = JSON.parse(process.argv[2]);
const sources = workloads.get(options.group);
assert(sources?.length, `Unknown or empty workload: ${options.group}`);
const adapter = await loadParser(options.parser, options.mode);
const parse = adapter.parse;
let sink = 0;
const runSync = () => {
  let count = 0;
  for (const source of sources) count += parse(source) as number;
  sink = (sink + count) | 0;
  return count;
};
const runAsync = async () => {
  let count = 0;
  for (const source of sources) count += await parse(source);
  sink = (sink + count) | 0;
  return count;
};
const run = adapter.asynchronous ? runAsync : runSync;
try {
  const gc = globalThis.gc;
  assert(gc, "Benchmark worker requires --expose-gc");
  const checksum = await run();
  const lazy = options.mode !== "parse";
  const bench = new Bench({
    warmupTime: lazy ? 2000 : 500,
    time: lazy ? 2000 : 1000,
    iterations: lazy ? 128 : 64,
    ...options.timing,
    warmupIterations: 1,
    throws: true,
    setup(_task, phase) {
      if (phase === "run") gc();
    },
  });
  bench.add(`${options.group}: ${options.parser.name}`, run, { async: adapter.asynchronous });
  await bench.run();
  assert.equal(bench.tasks[0]!.result.state, "completed");
  assert.equal(await run(), checksum, "Parser checksum changed during measurement");
  console.log(JSON.stringify({ pid: process.pid, checksum, sink, row: bench.table()[0] }));
} finally {
  adapter.dispose?.();
}
