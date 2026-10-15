import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Mode, ParserSpec } from "./parsers.ts";
import type { Measurement, WorkerOptions } from "./worker.ts";

// Shared-process runs showed import-order bias and interference from sh-syntax's Go/WASM runtime.
// Keep each parser/workload in a fresh process; Tinybench handles measurement and table formatting.
export const parsers: ParserSpec[] = [
  { kind: "unbash", name: "unbash", entry: fileURLToPath(new URL("../dist/parser.js", import.meta.url)) },
  { kind: "tree-sitter-bash-native", name: "tree-sitter-bash (native)" },
  { kind: "tree-sitter-bash-wasm", name: "tree-sitter-bash (WASM)" },
  { kind: "sh-syntax", name: "sh-syntax" },
  { kind: "bash-parser", name: "bash-parser" },
  { kind: "eric-bash-parser", name: "@ericcornelissen/bash-parser" },
];

export function run({
  parsers: selected = parsers,
  groups = ["short", "advanced", "medium", "large"],
  mode = "parse",
  rounds = 1,
  timing = {},
  timeout = 60_000,
}: {
  parsers?: ParserSpec[];
  groups?: string[];
  mode?: Mode;
  rounds?: number;
  timing?: WorkerOptions["timing"];
  timeout?: number;
} = {}) {
  const cases = groups.flatMap((group) =>
    selected
      .filter(
        (parser) =>
          (mode === "parse" || parser.kind === "unbash") &&
          (group === "short" || (parser.kind !== "bash-parser" && parser.kind !== "eric-bash-parser")),
      )
      .map((parser) => ({ parser, group, mode, timing })),
  );
  const results = [];
  const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));
  for (let round = 1; round <= rounds; round++) {
    for (const options of round % 2 ? cases : cases.toReversed()) {
      const child = spawnSync(process.execPath, ["--expose-gc", worker, JSON.stringify(options)], {
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
      });
      if (child.error || child.status !== 0) {
        throw new Error(
          `${options.parser.name}/${options.group}: ${child.error?.message || child.stderr || child.signal}`,
        );
      }
      const result: Measurement = JSON.parse(child.stdout);
      results.push({ round, ...result });
    }
  }
  return results;
}

if (import.meta.main) {
  if (process.argv.length > 2) throw new Error("Edit the configuration in bench/all.ts instead of passing CLI flags");
  console.table(run().map(({ round, row }) => ({ Round: round, ...row })));
}
