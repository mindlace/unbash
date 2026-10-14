import assert from "node:assert/strict";
import test from "node:test";
import { parseArithmeticExpression } from "../src/arithmetic.ts";
import { parse } from "../src/parser.ts";
import { print } from "../src/printer.ts";
import { nodeOfType } from "./ast-helpers.ts";

test("arithmetic recovery preserves enclosing groups, source ranges, and later operands", () => {
  const expression = nodeOfType(
    parseArithmeticExpression("(".repeat(300) + "1" + ")".repeat(300) + " + 2", 10),
    "ArithmeticBinary",
  );
  assert.equal(expression.operator, "+");
  assert.equal(nodeOfType(expression.right, "ArithmeticWord").value, "2");
  let inner = expression.left;
  let groups = 0;
  while (inner.type === "ArithmeticGroup") {
    groups++;
    inner = inner.expression;
  }
  assert.equal(groups, 257);
  assert.equal(inner.type, "ArithmeticWord");
  assert.equal(nodeOfType(inner, "ArithmeticWord").value, "(".repeat(43) + "1" + ")".repeat(43));
  assert.equal(inner.pos, 267);
  assert.equal(inner.end, 354);
  assert.equal(expression.pos, 10);
  assert.equal(expression.end, 615);
});

test("arithmetic recovery bounds recursive operators and preserves following expressions", () => {
  for (const prefix of ["a=", "2**", "!", "a?a:"]) {
    const expression = nodeOfType(parseArithmeticExpression(prefix.repeat(2000) + "1, tail"), "ArithmeticBinary");
    assert.equal(expression.operator, ",", prefix);
    assert.equal(nodeOfType(expression.right, "ArithmeticWord").value, "tail", prefix);
    assert.doesNotThrow(() => JSON.stringify(expression), prefix);
  }
});

test("operator chains past the limit recover silently and retain sibling commands", () => {
  const ast = parse("(( " + "!".repeat(2000) + "1 )); echo after");
  assert.equal(ast.errors, undefined);
  const command = nodeOfType(ast.commands[0].command, "ArithmeticCommand");
  const expression = command.expression;
  assert.equal(expression?.type, "ArithmeticUnary");
  assert.equal(command.expression, expression);
  assert.equal(ast.errors, undefined);
  assert.equal(nodeOfType(ast.commands[1].command, "Command").name?.value, "echo");
  assert.equal(nodeOfType(ast.commands[1].command, "Command").args[0].value, "after");
  assert.doesNotThrow(() => JSON.stringify(ast));
  assert.equal(ast.errors, undefined);
});

test("truncated arithmetic groups respect delimiters inside shell words", () => {
  const ast = parse("(( " + "(".repeat(300) + '$(printf ")")' + ")".repeat(300) + " + tail )); echo after");
  const expression = nodeOfType(
    nodeOfType(ast.commands[0].command, "ArithmeticCommand").expression,
    "ArithmeticBinary",
  );
  assert.equal(nodeOfType(expression.right, "ArithmeticWord").value, "tail");
  let inner = expression.left;
  while (inner.type === "ArithmeticGroup") inner = inner.expression;
  assert.equal(nodeOfType(inner, "ArithmeticWord").value, "(".repeat(43) + '$(printf ")")' + ")".repeat(43));
  assert.deepEqual(ast.errors, [{ message: "maximum arithmetic expression nesting depth exceeded", pos: 259 }]);
  assert.equal(nodeOfType(ast.commands[1].command, "Command").args[0].value, "after");
});

test("arithmetic for recovery retains every header field", () => {
  const source =
    "for (( " + "!".repeat(300) + "1; " + "!".repeat(300) + "2; " + "!".repeat(300) + "3 )); do echo body; done";
  const ast = parse(source);
  const loop = nodeOfType(ast.commands[0].command, "ArithmeticFor");
  assert.equal(ast.errors, undefined);
  assert.equal(loop.update?.type, "ArithmeticUnary");
  assert.equal(loop.initialize?.type, "ArithmeticUnary");
  assert.equal(loop.test?.type, "ArithmeticUnary");
  assert.equal(ast.errors, undefined);
  const printedPrefix = "! ".repeat(257) + "!".repeat(43);
  const expected =
    "for (( " + printedPrefix + "1; " + printedPrefix + "2; " + printedPrefix + "3 )); do\n  echo body\ndone";
  assert.equal(print(ast), expected);
  const serialized = JSON.parse(JSON.stringify(ast));
  assert.equal(print(serialized), expected);
  assert.equal(serialized.errors, undefined);
});
