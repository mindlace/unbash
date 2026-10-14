import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.ts";
import { print } from "../src/printer.ts";
import type { SyntaxNode } from "../src/types.ts";
import { nodeOfType } from "./ast-helpers.ts";

// Serialization materializes every lazy payload, so nested scripts are visited in source order.
function commandNames(root: SyntaxNode): string[] {
  const names: string[] = [];
  JSON.stringify(root, (_key, value) => {
    if (value?.type === "Command" && value.name) names.push(value.name.value);
    return value;
  });
  return names;
}

test("nesting recovery preserves later commands and a positioned diagnostic", () => {
  const ast = parse("( ".repeat(300) + "hidden" + " )".repeat(300) + "; visible");
  assert.deepEqual(ast.errors, [{ message: "maximum subshell nesting depth exceeded", pos: 512 }]);
  assert.deepEqual(commandNames(ast), ["visible"]);
  assert.equal(ast.commands.length, 2);
  const restored = JSON.parse(JSON.stringify(ast));
  assert.deepEqual(restored.errors, [{ message: "maximum subshell nesting depth exceeded", pos: 512 }]);
  assert.deepEqual(commandNames(restored), ["visible"]);
});

test("compound recovery resumes within its containing body and retains redirects", () => {
  const source = "{ ".repeat(256) + "{ hidden; } >out; kept" + "; }".repeat(256) + "; after";
  const ast = parse(source);
  assert.deepEqual(ast.errors, [{ message: "maximum brace group nesting depth exceeded", pos: 512 }]);
  assert.deepEqual(commandNames(ast), ["kept", "after"]);
  let command = ast.commands[0].command;
  for (let depth = 0; depth < 256; depth++) command = nodeOfType(command, "BraceGroup").body.commands[0].command;
  const redirected = nodeOfType(command, "Redirected");
  assert.equal(redirected.redirects.length, 1);
  assert.equal(nodeOfType(redirected.redirects[0], "Redirect").target?.text, "out");
  assert.deepEqual([redirected.command.pos, redirected.command.end], [512, 523]);
});

test("over-deep sub-fields inside a brace body keep their text without a diagnostic", () => {
  const source = "echo {a," + "${x:-".repeat(256) + "x" + "}".repeat(256) + "}; after";
  const ast = parse(source);
  assert.deepEqual(ast.errors, undefined);
  const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
  assert.equal(word.value.length, 1541);
  const parts = word.parts;
  assert.equal(parts?.[0].type, "BraceExpansion");
  assert.equal(word.parts, parts);
  assert.equal(word.value.length, 1541);
  assert.deepEqual(ast.errors, undefined);
  assert.deepEqual(commandNames(ast), ["echo", "after"]);
  const restored = JSON.parse(JSON.stringify(parse(source)));
  assert.equal(restored.errors, undefined);
  assert.equal(restored.commands[0].command.suffix[0].value.length, 1541);
  assert.ok(print(ast).endsWith("after"));
});

test("embedded script recovery keeps its diagnostics local", () => {
  const source = "echo $(" + "{ ".repeat(300) + "hidden" + "; }".repeat(300) + "; inside); outside";
  const ast = parse(source);
  const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
  assert.deepEqual(ast.errors, undefined);
  assert.equal(word.value.length, 1517);
  const expansion = nodeOfType(word.parts?.[0], "CommandExpansion");
  const script = expansion.script!;
  assert.deepEqual(script.errors, [{ message: "maximum brace group nesting depth exceeded", pos: 519 }]);
  assert.deepEqual(ast.errors, undefined);
  assert.equal(expansion.script, script);
  assert.deepEqual(commandNames(ast), ["echo", "inside", "outside"]);
});

test("quoted substitutions left open inside scanned extents are reported while parsing", () => {
  const cases: [string, { message: string; pos: number }[]][] = [
    [
      'a=("$(echo")',
      [
        { message: "unterminated extended glob", pos: 1 },
        { message: "unterminated command substitution", pos: 4 },
      ],
    ],
    [
      'echo $(( 1 + "$(x" ))',
      [
        { message: "unterminated arithmetic expansion", pos: 5 },
        { message: "unterminated command substitution", pos: 14 },
      ],
    ],
    [
      'echo ${x:-"$(y"}',
      [
        { message: "unterminated parameter expansion", pos: 5 },
        { message: "unterminated command substitution", pos: 11 },
      ],
    ],
    [
      'echo $[ "$(x" ]',
      [
        { message: "unterminated double quote", pos: 8 },
        { message: "unterminated command substitution", pos: 9 },
      ],
    ],
  ];
  for (const [source, errors] of cases) {
    const ast = parse(source);
    assert.deepEqual(ast.errors, errors, source);
    JSON.stringify(ast);
    assert.deepEqual(ast.errors, errors, source);
  }
});

test("arithmetic depth is reported while scanning and materialization adds nothing", () => {
  const first = parse("echo $((" + "(".repeat(300) + "1" + ")".repeat(300) + "))");
  const second = parse('echo "unfinished');
  const limit = [{ message: "maximum arithmetic expression nesting depth exceeded", pos: 264 }];
  assert.deepEqual(first.errors, limit);
  const errors = JSON.parse(JSON.stringify(second.errors));
  const firstWord = nodeOfType(nodeOfType(first.commands[0].command, "Command").args[0], "Word");
  assert.equal(nodeOfType(firstWord.parts?.[0], "ArithmeticExpansion").expression?.type, "ArithmeticGroup");
  assert.deepEqual(first.errors, limit);
  const secondWord = nodeOfType(nodeOfType(second.commands[0].command, "Command").args[0], "Word");
  assert.equal(secondWord.value, "unfinished");
  assert.deepEqual(second.errors, errors);
  assert.deepEqual(JSON.parse(JSON.stringify(second)).errors, errors);
});

test("decoded backtick scripts report in their own coordinates", () => {
  const ast = parse("echo `echo \\$((" + "(".repeat(300) + "1" + ")".repeat(300) + "))`");
  const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
  const nested = nodeOfType(word.parts?.[0], "CommandExpansion").script!;
  assert.equal(nested.source?.length, 611);
  const limit = [{ message: "maximum arithmetic expression nesting depth exceeded", pos: 263 }];
  assert.deepEqual(nested.errors, limit);
  assert.deepEqual(JSON.parse(JSON.stringify(nested)).errors, limit);
  assert.deepEqual(ast.errors, undefined);
});

test("heredoc bodies do not read $' or $\" as quotes", () => {
  for (const source of ["cat <<EOF\n# regex '^EOF$'\nEOF", 'cat <<EOF\n$"literal\nEOF']) {
    const ast = parse(source);
    const heredoc = nodeOfType(nodeOfType(ast.commands[0].command, "Command").redirects[0], "HereDoc");
    assert.equal(heredoc.body.parts, undefined);
    assert.equal(ast.errors, undefined);
    assert.equal(JSON.parse(JSON.stringify(ast)).errors, undefined);
  }
  const ast = parse("cat <<EOF\n$''$bar\nEOF");
  const heredoc = nodeOfType(nodeOfType(ast.commands[0].command, "Command").redirects[0], "HereDoc");
  assert.deepEqual(heredoc.body.parts, [
    { type: "Literal", pos: 10, end: 13, text: "$''", value: "$''" },
    { type: "SimpleExpansion", pos: 13, end: 17, text: "$bar" },
    { type: "Literal", pos: 17, end: 18, text: "\n", value: "\n" },
  ]);
  assert.equal(ast.errors, undefined);
});

test("assignment and array values past the limit keep their text without a diagnostic", () => {
  const value = "{a," + "${x:-".repeat(256) + "x" + "}".repeat(256) + "}";
  for (const source of ["X=" + value, "export X=" + value, "X=(" + value + ")"]) {
    const ast = parse(source + "; after");
    const command = nodeOfType(ast.commands[0].command, "Command");
    const assignment = nodeOfType(command.prefix[0] ?? command.suffix[0], "Assignment");
    assert.equal(ast.errors, undefined);
    const word = assignment.value.type === "ArrayValue" ? assignment.value.elements[0] : assignment.value;
    assert.equal(word.value.length, 1541);
    assert.equal(ast.errors, undefined);
    assert.deepEqual(commandNames(ast), source.startsWith("export") ? ["export", "after"] : ["after"]);
    assert.equal(JSON.parse(JSON.stringify(ast)).errors, undefined);
  }
});

test("scripts are plain objects whose errors are complete when parse returns", () => {
  const deep = "echo $((" + "(".repeat(300) + "1" + ")".repeat(300) + "))";
  const limit = { message: "maximum arithmetic expression nesting depth exceeded", pos: 264 };
  for (const source of ["echo plain", deep]) {
    const ast = Object.freeze(parse(source));
    assert.equal(Object.getPrototypeOf(ast), Object.prototype);
    assert.deepEqual(Object.keys(ast), ["type", "pos", "end", "shebang", "commands", "errors"]);
    assert.deepEqual(ast.errors, source === deep ? [limit] : undefined);
    const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
    assert.equal(word.parts?.[0]?.type, source === deep ? "ArithmeticExpansion" : undefined);
    const restored = JSON.parse(JSON.stringify(ast));
    assert.deepEqual(restored.errors, ast.errors);
  }
});
