import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.ts";
import type { ParsedScript } from "../src/types.ts";
import { nodeOfType } from "./ast-helpers.ts";

const argument = (source: string) =>
  nodeOfType(nodeOfType(parse(source).commands[0].command, "Command").args[0], "Word");

test("embedded script getters use the same enumeration contract as word parts", () => {
  const command = nodeOfType(argument("echo $(pwd)").parts?.[0], "CommandExpansion");
  const process = nodeOfType(argument("echo <(pwd)").parts?.[0], "ProcessSubstitution");
  const arithmetic = nodeOfType(argument("echo $(( $(pwd) ))").parts?.[0], "ArithmeticExpansion");
  const arithmeticCommand = nodeOfType(arithmetic.expression, "ArithmeticCommandExpansion");
  for (const expansion of [command, process, arithmeticCommand]) {
    assert.equal(Object.keys(expansion).includes("script"), false);
    assert.equal(JSON.parse(JSON.stringify(expansion)).script.type, "Script");
    assert.equal(Object.keys(expansion).includes("script"), false);
  }
});

test("word values and parts leave arithmetic expressions deferred in either access order", () => {
  const body = "(".repeat(300) + "1" + ")".repeat(300);
  const expected = [{ message: "maximum arithmetic expression nesting depth exceeded", pos: 264 }];
  for (const valueFirst of [true, false]) {
    const ast = parse("echo $((" + body + "))");
    assert.deepEqual(ast.errors, expected);
    const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
    if (valueFirst) assert.equal(word.value.length, 606);
    const expansion = nodeOfType(word.parts?.[0], "ArithmeticExpansion");
    assert.equal(word.value.length, 606);
    const expression = expansion.expression;
    assert.equal(expression?.type, "ArithmeticGroup");
    for (let read = 0; read < 2; read++) {
      assert.equal(expansion.expression, expression);
      assert.deepEqual(ast.errors, expected);
      assert.equal(word.value.length, 606);
      assert.equal(word.parts?.[0], expansion);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(ast)).errors, expected);
  }
});

test("word values and parts leave substitution scripts deferred", () => {
  const body = "{ ".repeat(300) + ":" + "; }".repeat(300);
  for (const [open, close] of [
    ["`", "`"],
    ["$(", ")"],
    ["<(", ")"],
  ]) {
    for (const valueFirst of [true, false]) {
      const ast = parse("echo " + open + body + close);
      const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
      if (valueFirst) assert.equal(word.value.length, open === "`" ? 1503 : 1504);
      const expansion = nodeOfType(word.parts?.[0], "CommandExpansion", "ProcessSubstitution");
      assert.equal(word.value.length, open === "`" ? 1503 : 1504);
      const script = expansion.script;
      for (let read = 0; read < 2; read++) {
        assert.equal(expansion.script, script);
        assert.deepEqual(script?.errors, [
          { message: "maximum brace group nesting depth exceeded", pos: open === "`" ? 518 : 519 },
        ]);
        assert.equal(ast.errors, undefined);
        assert.equal(word.parts?.[0], expansion);
      }
      assert.equal(JSON.parse(JSON.stringify(word)).parts[0].script.errors.length, 1);
    }
  }
});

test("arithmetic expressions leave command substitution scripts deferred", () => {
  const body = "{ ".repeat(300) + ":" + "; }".repeat(300);
  const word = argument("echo $(( $(" + body + ") + 1 ))");
  const expansion = nodeOfType(word.parts?.[0], "ArithmeticExpansion");
  const expression = nodeOfType(expansion.expression, "ArithmeticBinary");
  assert.equal(expression.operator, "+");
  const substitution = nodeOfType(expression.left, "ArithmeticCommandExpansion");
  const script = substitution.script;
  assert.deepEqual(script?.errors, [{ message: "maximum brace group nesting depth exceeded", pos: 523 }]);
  assert.equal(expansion.expression, expression);
  assert.equal(substitution.script, script);
});

test("deferred arithmetic inside substitutions inherits its enclosing depth", () => {
  const word = argument("echo $(echo $((" + "(".repeat(256) + "1" + ")".repeat(256) + ")))");
  const substitution = nodeOfType(word.parts?.[0], "CommandExpansion");
  const script = substitution.script;
  const expected = [{ message: "maximum arithmetic expression nesting depth exceeded", pos: 270 }];
  assert.deepEqual(script?.errors, expected);
  const command = nodeOfType(script?.commands[0].command, "Command");
  const nested = nodeOfType(command.args[0], "Word");
  const arithmetic = nodeOfType(nested.parts?.[0], "ArithmeticExpansion");
  assert.equal(nested.value.length, 518);
  assert.equal(arithmetic.expression?.type, "ArithmeticGroup");
  assert.deepEqual(script?.errors, expected);
});

test("nested arithmetic expansions share the depth allowance and report the first truncated parenthesis", () => {
  const accepted = parse("echo " + "$(( ".repeat(255) + "((1))" + " ))".repeat(255));
  assert.doesNotThrow(() => JSON.stringify(accepted));
  assert.equal(accepted.errors, undefined);
  const recovered = parse("echo " + "$(( ".repeat(256) + "((1))" + " ))".repeat(256));
  const limit = [{ message: "maximum arithmetic expression nesting depth exceeded", pos: 1030 }];
  assert.deepEqual(recovered.errors, limit);
  const word = nodeOfType(nodeOfType(recovered.commands[0].command, "Command").args[0], "Word");
  assert.equal(word.parts?.[0].type, "ArithmeticExpansion");
  assert.deepEqual(JSON.parse(JSON.stringify(recovered)).errors, limit);
  const nested = parse("echo $(( $(( " + "(".repeat(256) + "1+1" + ")".repeat(256) + " )) ))");
  assert.deepEqual(nested.errors, [{ message: "maximum arithmetic expression nesting depth exceeded", pos: 268 }]);
});

test("nested parameter arithmetic remains deferred and keeps absolute positions", () => {
  const ast = parse("echo ${x:-$((" + "(".repeat(300) + "1" + ")".repeat(300) + "))}");
  const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
  const parameter = nodeOfType(word.parts?.[0], "ParameterExpansion");
  assert.equal(parameter.operation?.type, "Default");
  if (parameter.operation?.type !== "Default") return;
  const arithmetic = nodeOfType(parameter.operation.operand.parts?.[0], "ArithmeticExpansion");
  assert.equal(arithmetic.pos, 10);
  assert.equal(word.value.length, 612);
  assert.equal(ast.errors, undefined);
  assert.equal(arithmetic.expression?.type, "ArithmeticGroup");
  assert.equal(ast.errors, undefined);
});

test("deferred payloads cache successful results and serialize complete syntax", () => {
  const ast = parse("echo $(( $(pwd) + 1 ))");
  const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
  const arithmetic = nodeOfType(word.parts?.[0], "ArithmeticExpansion");
  const expression = nodeOfType(arithmetic.expression, "ArithmeticBinary");
  const substitution = nodeOfType(expression.left, "ArithmeticCommandExpansion");
  const script = substitution.script;
  assert.ok(script);
  assert.equal(arithmetic.expression, expression);
  assert.equal(substitution.script, script);
  assert.deepEqual([script.pos, script.end], [11, 14]);
  assert.equal(nodeOfType(script.commands[0].command, "Command").name?.value, "pwd");
  const restored: ParsedScript = JSON.parse(JSON.stringify(parse("echo $(( $(pwd) + 1 ))")));
  const restoredWord = nodeOfType(nodeOfType(restored.commands[0].command, "Command").suffix[0], "Word");
  const restoredArithmetic = nodeOfType(restoredWord.parts?.[0], "ArithmeticExpansion");
  const restoredExpression = nodeOfType(restoredArithmetic.expression, "ArithmeticBinary");
  assert.equal(
    nodeOfType(nodeOfType(restoredExpression.left, "ArithmeticCommandExpansion").script?.commands[0].command, "Command")
      .name?.value,
    "pwd",
  );
});

test("escaped backtick scripts retain decoded source ownership and local diagnostics", () => {
  const ast = parse("echo `printf \\$HOME`");
  const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
  assert.equal(word.value, "`printf \\$HOME`");
  const expansion = nodeOfType(word.parts?.[0], "CommandExpansion");
  assert.equal(expansion.script?.source, "printf $HOME");
  assert.deepEqual([expansion.script?.pos, expansion.script?.end], [0, 12]);
  const restored: ParsedScript = JSON.parse(JSON.stringify(ast));
  const restoredWord = nodeOfType(nodeOfType(restored.commands[0].command, "Command").suffix[0], "Word");
  assert.equal(nodeOfType(restoredWord.parts?.[0], "CommandExpansion").script?.source, "printf $HOME");

  const malformed = parse("echo `if`");
  const malformedWord = nodeOfType(nodeOfType(malformed.commands[0].command, "Command").args[0], "Word");
  const malformedExpansion = nodeOfType(malformedWord.parts?.[0], "CommandExpansion");
  assert.equal(malformed.errors, undefined);
  assert.ok(malformedExpansion.script?.errors?.length);
  assert.equal(malformed.errors, undefined);
});
