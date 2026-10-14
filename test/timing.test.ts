import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.ts";
import { print } from "../src/printer.ts";
import { nodeOfType } from "./ast-helpers.ts";

test("timing and negation retain prefix order around the complete pipeline", () => {
  for (const [source, prefixes] of [
    ["time ! first | second", ["Time", "Negation"]],
    ["! time first | second", ["Negation", "Time"]],
    ["time ! time -p ! first | second", ["Time", "Negation", "Time", "Negation"]],
    ["time time first | second", ["Time", "Time"]],
  ] as const) {
    const ast = parse(source);
    const node = nodeOfType(ast.commands[0].command, "Pipeline");
    assert.deepEqual(
      node.prefixes.map((prefix) => prefix.type),
      prefixes,
      source,
    );
    assert.deepEqual(
      node.commands.map((command) => command.type),
      ["Command", "Command"],
      source,
    );
    assert.deepEqual(node.operators, ["|"], source);
    assert.equal("time" in node, false, source);
    assert.equal("negated" in node, false, source);
    assert.equal(ast.errors, undefined, source);
    assert.equal(print(ast), source, source);
    assert.equal(print(parse(print(ast))), source, source);
  }
});

test("bare prefix JSON has one child owner and complete keyword and flag ranges", () => {
  const ast = parse("! time -p --");
  assert.deepEqual(JSON.parse(JSON.stringify(ast.commands[0].command)), {
    type: "Pipeline",
    pos: 0,
    end: 12,
    prefixes: [
      { type: "Negation", pos: 0, end: 1 },
      {
        type: "Time",
        pos: 2,
        end: 12,
        keywordEnd: 6,
        posix: { pos: 7, end: 9 },
        endOfOptions: { pos: 10, end: 12 },
      },
    ],
    commands: [],
    operators: [],
  });
});

test("timing preserves option presence and source ranges", () => {
  for (const [source, keywordEnd, posix, endOfOptions, printed] of [
    ["  time  ", 6, undefined, undefined, "time"],
    ["time -p", 4, { pos: 5, end: 7 }, undefined, "time -p"],
    ["time --", 4, undefined, { pos: 5, end: 7 }, "time --"],
    ["time -p --", 4, { pos: 5, end: 7 }, { pos: 8, end: 10 }, "time -p --"],
    ["ti\\\nme -\\\np --", 6, { pos: 7, end: 11 }, { pos: 12, end: 14 }, "time -p --"],
  ] as const) {
    const ast = parse(source);
    const pipeline = nodeOfType(ast.commands[0].command, "Pipeline");
    const time = nodeOfType(pipeline.prefixes[0], "Time");
    assert.equal(time.keywordEnd, keywordEnd, source);
    assert.deepEqual(time.posix, posix, source);
    assert.deepEqual(time.endOfOptions, endOfOptions, source);
    assert.deepEqual(pipeline.commands, [], source);
    assert.equal(time.end, source.trimEnd().length, source);
    assert.equal(pipeline.end, source.trimEnd().length, source);
    assert.equal(ast.errors, undefined, source);
    assert.equal(print(ast), printed, source);
  }
});

test("timing consumes each eligible option only once", () => {
  for (const [source, name] of [
    ["time -p -p arg", "-p"],
    ["time -- -p arg", "-p"],
    ["time -p -- -- arg", "--"],
    ["time '--' arg", "--"],
    ["time -p '--' arg", "--"],
  ]) {
    const ast = parse(source);
    const pipeline = nodeOfType(ast.commands[0].command, "Pipeline");
    assert.equal(pipeline.prefixes.length, 1, source);
    assert.equal(nodeOfType(pipeline.commands[0], "Command").name?.value, name, source);
    assert.equal(ast.errors, undefined, source);
    assert.equal(print(ast), source, source);
  }
});

test("timing remains an ordinary word after a pipe or command prefix", () => {
  for (const source of ["first | time -p second", "A=1 time -p second", ">out time -p second"]) {
    const ast = parse(source);
    const node = ast.commands[0].command;
    const command = node.type === "Pipeline" ? node.commands[1] : node;
    assert.ok(command.type === "Command", source);
    assert.equal(command.name?.value, "time", source);
    assert.equal(ast.errors, undefined, source);
  }
});

test("long prefix sequences stay flat", () => {
  const source = "! time ".repeat(10000) + ":";
  const ast = parse(source);
  const pipeline = nodeOfType(ast.commands[0].command, "Pipeline");
  assert.equal(ast.errors, undefined);
  assert.equal(pipeline.prefixes.length, 20000);
  assert.equal(nodeOfType(pipeline.commands[0], "Command").name?.text, ":");
  assert.equal(print(ast), source);
});

test("prefixes do not consume compound command nesting levels", () => {
  const ast = parse("! ".repeat(256) + "{ echo body; }; echo after");
  const pipeline = nodeOfType(ast.commands[0].command, "Pipeline");
  assert.equal(ast.errors, undefined);
  assert.equal(pipeline.prefixes.length, 256);
  assert.equal(pipeline.commands[0].type, "BraceGroup");
  assert.equal(nodeOfType(ast.commands[1].command, "Command").name?.text, "echo");
});

test("continued negation retains its complete keyword range", () => {
  const ast = parse("!\\\n !\\\n false");
  const pipeline = nodeOfType(ast.commands[0].command, "Pipeline");
  assert.deepEqual([pipeline.pos, pipeline.end], [0, 13]);
  assert.deepEqual(
    pipeline.prefixes.map((prefix) => [prefix.type, prefix.pos, prefix.end]),
    [
      ["Negation", 0, 3],
      ["Negation", 4, 7],
    ],
  );
  assert.equal(print(ast), "! ! false");
  assert.equal(ast.errors, undefined);
});
