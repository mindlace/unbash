import { nodeOfType, redirectsOf } from "./ast-helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.ts";
import { print } from "../src/printer.ts";

test("repeated negation applies to the entire pipeline", () => {
  const ast = parse("! ! false | true && echo yes");
  const andOr = ast.commands[0].command;
  assert.ok(andOr.type === "AndOr");
  assert.deepEqual(andOr.operators, ["&&"]);
  const pipeline = nodeOfType(andOr.commands[0], "Pipeline");
  assert.deepEqual(
    pipeline.prefixes.map((prefix) => [prefix.type, prefix.pos, prefix.end]),
    [
      ["Negation", 0, 1],
      ["Negation", 2, 3],
    ],
  );
  assert.deepEqual([pipeline.pos, pipeline.end], [0, 16]);
  assert.deepEqual(pipeline.operators, ["|"]);
  assert.deepEqual(
    pipeline.commands.map((command) => command.type === "Command" && command.name?.text),
    ["false", "true"],
  );
  assert.equal(ast.errors, undefined);
  assert.equal(print(ast), "! ! false | true && echo yes");
});

test("quoted and escaped bangs remain command words after negation", () => {
  for (const name of ["'!'", '"!"', "\\!"]) {
    const ast = parse(`! ! ${name} arg !`);
    const pipeline = nodeOfType(ast.commands[0].command, "Pipeline");
    assert.equal(pipeline.prefixes.length, 2);
    const command = nodeOfType(pipeline.commands[0], "Command");
    assert.equal(command.name?.text, name);
    assert.equal(command.name.value, "!");
    assert.deepEqual(
      command.suffix.map((word) => nodeOfType(word, "Assignment", "Word").text),
      ["arg", "!"],
    );
    assert.equal(ast.errors, undefined);
  }
});

test("bare negation runs preserve empty commands and source ranges", () => {
  const N = "Negation";
  const cases: [string, string[], number, number, string][] = [
    ["!", [N], 0, 1, "!"],
    ["  ! !  ", [N, N], 2, 5, "! !"],
    ["! ! !", [N, N, N], 0, 5, "! ! !"],
    ["! ! ! !", [N, N, N, N], 0, 7, "! ! ! !"],
    ["time ! !", ["Time", N, N], 0, 8, "time ! !"],
  ];
  for (const [source, prefixes, pos, end, printed] of cases) {
    const ast = parse(source);
    const pipeline = nodeOfType(ast.commands[0].command, "Pipeline");
    assert.deepEqual([pipeline.pos, pipeline.end], [pos, end], source);
    assert.deepEqual(
      pipeline.prefixes.map((prefix) => prefix.type),
      prefixes,
      source,
    );
    assert.deepEqual(pipeline.commands, [], source);
    assert.equal(ast.errors, undefined, source);
    assert.equal(print(ast), printed, source);
  }
});

test("bare even negation survives statement and conditional printing", () => {
  const cases = [
    ["false; ! !; echo $?", "false\n! !\necho $?"],
    ["if ! !; then echo yes; fi", "if ! !; then\n  echo yes\nfi"],
    ["! !\necho next", "! !\necho next"],
  ];
  for (const [source, expected] of cases) {
    const ast = parse(source);
    assert.equal(ast.errors, undefined, source);
    const printed = print(ast);
    assert.equal(printed, expected, source);
    const reparsed = parse(printed);
    assert.equal(reparsed.errors, undefined, source);
    assert.equal(print(reparsed), expected, source);
  }
});

test("repeated negation retains compound redirects and background execution", () => {
  const ast = parse("! ! { echo yes; } > out &");
  const statement = ast.commands[0];
  const pipeline = nodeOfType(statement.command, "Pipeline");
  assert.equal(statement.background, true);
  assert.equal(pipeline.prefixes.length, 2);
  assert.deepEqual([pipeline.pos, pipeline.end], [0, 23]);
  const command = nodeOfType(pipeline.commands[0], "Redirected");
  assert.equal(command.command.type, "BraceGroup");
  assert.deepEqual(
    redirectsOf(command).map((redirect) => [
      redirect.operator,
      nodeOfType(redirect, "HereString", "Redirect").target?.text,
    ]),
    [[">", "out"]],
  );
  assert.equal(ast.errors, undefined);
  assert.equal(print(ast), "! ! {\n  echo yes\n} > out &");
});

test("repeated negation preserves errors and ranges for unfinished pipelines", () => {
  const cases: [string, string, number, number, string[]][] = [
    ["! ! | echo after", "unexpected token '|'", 4, 3, []],
    ["! ! cmd |", "expected command after '|'", 9, 7, ["Command"]],
    ["! ! cmd |&", "expected command after '|&'", 10, 7, ["Command"]],
  ];
  for (const [source, message, pos, end, commands] of cases) {
    const ast = parse(source);
    const pipeline = nodeOfType(ast.commands[0].command, "Pipeline");
    assert.equal(pipeline.prefixes.length, 2, source);
    assert.deepEqual([pipeline.pos, pipeline.end], [0, end], source);
    assert.deepEqual(
      pipeline.commands.map((command) => command.type),
      commands,
      source,
    );
    assert.deepEqual(ast.errors, [{ message, pos }], source);
  }
});
