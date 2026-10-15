import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parsers, run } from "../bench/all.ts";
import { workloads } from "../bench/fixtures.ts";
import type { ParserSpec } from "../bench/parsers.ts";

const timing = { warmupTime: 0, time: 1, iterations: 2 };
const quick = { groups: ["short"], timing };
const sourceEntry = fileURLToPath(new URL("../src/parser.ts", import.meta.url));

function fixture(t: TestContext, source = "export const parse = () => ({ commands: [{}] });"): ParserSpec {
  const directory = mkdtempSync(join(tmpdir(), "unbash-benchmark-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, "parser.mjs");
  writeFileSync(entry, source);
  return { kind: "unbash", name: "test", entry };
}

test("the four README workloads retain their exact sources and order", () => {
  const actual = ["short", "advanced", "medium", "large"].map((name) => {
    const sources = workloads.get(name)!;
    return {
      name,
      scripts: sources.length,
      bytes: sources.reduce((sum, source) => sum + Buffer.byteLength(source), 0),
      hash: createHash("sha256").update(JSON.stringify(sources)).digest("hex"),
    };
  });
  assert.deepEqual(actual, [
    {
      name: "short",
      scripts: 26,
      bytes: 1172,
      hash: "88049b0a3ceea4bce716ca2706bf4f2033ff7f23fdf7585e2d1c7577119bb220",
    },
    {
      name: "advanced",
      scripts: 14,
      bytes: 873,
      hash: "26d96ab2c2a74883014d8059a8a24d2cca06c673675b603a77afbd43b76d6661",
    },
    {
      name: "medium",
      scripts: 5,
      bytes: 153453,
      hash: "2a4b7813f44e9107ff4161870ed75b884ac0d3dfa97387a3a3b4c987d623eff8",
    },
    {
      name: "large",
      scripts: 5,
      bytes: 993342,
      hash: "a3a7f3f7d4b8db95447db4d2a22f4918ce65bdfa3a4dded40770f36218509045",
    },
  ]);
});

test("benchmark configuration is edited in the script instead of parsed from CLI flags", () => {
  const cli = fileURLToPath(new URL("../bench/all.ts", import.meta.url));
  const child = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 1000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /configuration in bench\/all.ts/);
  assert.equal(child.stdout, "");
});

test("repeated comparisons alternate order in fresh processes", (t) => {
  const parser = fixture(t);
  const results = run({
    ...quick,
    parsers: [
      { ...parser, name: "A" },
      { ...parser, name: "B" },
    ],
    rounds: 2,
  });
  assert.deepEqual(
    results.map(({ row }) => row["Task name"]),
    ["short: A", "short: B", "short: B", "short: A"],
  );
  assert.deepEqual(
    results.map(({ round }) => round),
    [1, 1, 2, 2],
  );
  assert.equal(new Set(results.map(({ pid }) => pid)).size, 4);
  for (const result of results) {
    assert.notEqual(result.pid, process.pid);
    assert.equal(result.checksum, 26);
    assert.ok(result.sink > 0);
  }
});

test("Tinybench supplies the requested sample count and native table", (t) => {
  const [result] = run({ ...quick, parsers: [fixture(t)], timing: { ...timing, iterations: 16, time: 0.000001 } });
  assert.equal(result.row["Task name"], "short: test");
  assert.equal(result.row.Samples, 16);
  assert.ok(result.row["Latency avg (ns)"]);
  assert.ok(result.row["Throughput avg (ops/s)"]);
});

test("all parser adapters run against the supported default workloads", () => {
  const selected = parsers.map((parser) => (parser.kind === "unbash" ? { ...parser, entry: sourceEntry } : parser));
  const results = run({ parsers: selected, timing });
  assert.equal(results.length, 18);
  assert.equal(new Set(results.map(({ pid }) => pid)).size, 18);
  assert.equal(new Set(results.map(({ row }) => row["Task name"])).size, 18);
  for (const result of results) {
    assert.ok(result.checksum > 0);
    assert.ok(Number(result.row.Samples) >= 2);
  }
});

for (const mode of ["value", "parts", "json"] as const) {
  test(`${mode} mode runs unbash through the same worker`, () => {
    const selected = parsers.map((parser) => (parser.kind === "unbash" ? { ...parser, entry: sourceEntry } : parser));
    const results = run({ ...quick, parsers: selected, mode });
    assert.equal(results.length, 1);
    assert.equal(results[0].row["Task name"], "short: unbash");
    assert.ok(results[0].checksum > 0);
  });
}

test("parser failures propagate from startup and measurement", (t) => {
  const failed = fixture(t, 'export const parse = () => { throw new Error("startup failed"); };');
  assert.throws(() => run({ ...quick, parsers: [failed] }), /startup failed/);
  const later = fixture(
    t,
    `
    let calls = 0;
    export const parse = () => {
      if (++calls > 52) throw new Error("measurement failed");
      return { commands: [{}] };
    };
  `,
  );
  assert.throws(() => run({ ...quick, parsers: [later] }), /measurement failed/);
});

test("a worker that never returns is terminated", (t) => {
  const parser = fixture(t, "export const parse = () => { while (true) {} };");
  assert.throws(() => run({ ...quick, parsers: [parser], timeout: 100 }), /ETIMEDOUT/);
});
