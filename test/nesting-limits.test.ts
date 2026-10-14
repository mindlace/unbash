import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.ts";
import { nodeOfType } from "./ast-helpers.ts";

test("parameter nesting past the limit is reported while scanning and keeps the word", () => {
  const source = "echo " + "${x:-".repeat(257) + "x" + "}".repeat(257) + "; after";
  const ast = parse(source);
  const expected = [{ message: "maximum parameter expansion nesting depth exceeded", pos: 1285 }];
  assert.deepEqual(ast.errors, expected);
  const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
  assert.equal(word.value.length, 1543);
  const parts = word.parts;
  assert.equal(parts?.[0].type, "ParameterExpansion");
  assert.equal(word.parts, parts);
  assert.deepEqual(ast.errors, expected);
  assert.deepEqual(JSON.parse(JSON.stringify(ast)).errors, expected);
  assert.equal(nodeOfType(ast.commands[1].command, "Command").name?.value, "after");
});

test("recursive quoted expansions serialize their partial syntax and preserve later commands", () => {
  for (const [open, close, length] of [
    ['"${x:-', '}"', 16001],
    ['"$(echo ', ')"', 20001],
    ['"${x:-$(echo ', ')}"', 32001],
  ] as const) {
    const source = "echo " + open.repeat(2000) + "x" + close.repeat(2000) + "; after";
    const ast = parse(source);
    const restored = JSON.parse(JSON.stringify(ast));
    assert.ok(restored.errors.some((error: { message: string }) => error.message.includes("nesting depth")));
    assert.equal(restored.commands.length, 2);
    assert.equal(restored.commands[0].command.suffix[0].text.length, length);
    assert.equal(restored.commands[1].command.name.value, "after");
    assert.deepEqual(ast.errors, restored.errors);
  }
});

test("arithmetic recursion keeps partial expressions and reports parenthesis depth while scanning", () => {
  const limit = { message: "maximum arithmetic expression nesting depth exceeded", pos: 259 };
  for (const [body, type, errors] of [
    ["(".repeat(2000) + "1" + ")".repeat(2000), "ArithmeticGroup", [limit]],
    ["a=".repeat(2000) + "1", "ArithmeticBinary", undefined],
    ["2**".repeat(2000) + "1", "ArithmeticBinary", undefined],
    ["!".repeat(2000) + "1", "ArithmeticUnary", undefined],
    ["a?a:".repeat(2000) + "1", "ArithmeticTernary", undefined],
  ] as const) {
    const ast = parse("(( " + body + " )); after");
    assert.deepEqual(ast.errors, errors);
    const command = nodeOfType(ast.commands[0].command, "ArithmeticCommand");
    const expression = command.expression;
    assert.equal(expression?.type, type);
    assert.equal(command.expression, expression);
    assert.deepEqual(ast.errors, errors);
    assert.deepEqual(JSON.parse(JSON.stringify(ast)).errors, errors);
    assert.equal(nodeOfType(ast.commands[1].command, "Command").name?.value, "after");
  }
});

test("iterative arithmetic chains retain their complete expression", () => {
  const ast = parse("(( 1" + "+1".repeat(4000) + " ))");
  let expression = nodeOfType(ast.commands[0].command, "ArithmeticCommand").expression;
  let operators = 0;
  while (expression?.type === "ArithmeticBinary") {
    operators++;
    expression = expression.left;
  }
  assert.equal(operators, 4000);
  assert.equal(ast.errors, undefined);
});

test("sibling expansions do not consume the nesting allowance", () => {
  for (const source of ["echo $(echo " + "$((1)) ".repeat(300) + ")", "echo $(( " + "$((1))+".repeat(300) + "1 ))"]) {
    const ast = parse(source);
    assert.equal(ast.errors, undefined);
    assert.doesNotThrow(() => JSON.stringify(ast));
  }
});
