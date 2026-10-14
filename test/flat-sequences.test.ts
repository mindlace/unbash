import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.ts";
import { print } from "../src/printer.ts";
import { nodeOfType } from "./ast-helpers.ts";
import { verify } from "./verify.ts";

test("elif branches are siblings with their own source ranges", () => {
  const source = "if a; then b; elif c; then d; elif e; then f; else g; fi";
  const ast = parse(source);
  const command = nodeOfType(ast.commands[0].command, "If");
  assert.equal(ast.errors, undefined);
  assert.deepEqual(
    {
      type: command.type,
      pos: command.pos,
      end: command.end,
      clause: [command.clause.pos, command.clause.end],
      body: [command.then.pos, command.then.end],
      elif: command.elif?.map((branch) => ({
        type: branch.type,
        pos: branch.pos,
        end: branch.end,
        clause: [branch.clause.pos, branch.clause.end],
        body: [branch.then.pos, branch.then.end],
      })),
      else: command.else && [command.else.type, command.else.pos, command.else.end],
    },
    {
      type: "If",
      pos: 0,
      end: 56,
      clause: [3, 4],
      body: [11, 12],
      elif: [
        { type: "Elif", pos: 14, end: 28, clause: [19, 20], body: [27, 28] },
        { type: "Elif", pos: 30, end: 44, clause: [35, 36], body: [43, 44] },
      ],
      else: ["CompoundList", 51, 52],
    },
  );
  assert.equal(verify(source, ast), source);
  assert.equal(print(ast), "if a; then\n  b\nelif c; then\n  d\nelif e; then\n  f\nelse\n  g\nfi");
});

test("else bodies retain genuinely nested if commands", () => {
  const ast = parse("if a; then b; else if c; then d; fi; fi");
  const command = nodeOfType(ast.commands[0].command, "If");
  assert.equal(ast.errors, undefined);
  assert.deepEqual(command.elif, []);
  const body = nodeOfType(command.else, "CompoundList");
  const nested = nodeOfType(body.commands[0].command, "If");
  assert.deepEqual([nested.pos, nested.end], [19, 35]);
  assert.deepEqual(nested.elif, []);
  assert.equal(print(ast), "if a; then\n  b\nelse\n  if c; then\n    d\n  fi\nfi");

  const braced = parse("if a; then b; else { if c; then d; fi; }; fi");
  const outer = nodeOfType(braced.commands[0].command, "If");
  const brace = nodeOfType(outer.else?.commands[0].command, "BraceGroup");
  assert.equal(braced.errors, undefined);
  assert.deepEqual(outer.elif, []);
  assert.equal(brace.body.commands[0].command.type, "If");
  assert.equal(print(braced), "if a; then\n  b\nelse\n  {\n    if c; then\n      d\n    fi\n  }\nfi");
});

test("an empty elif body does not overlap the following branch", () => {
  const source = "if a; then b; elif c; then elif d; then e; fi";
  const ast = parse(source);
  const command = nodeOfType(ast.commands[0].command, "If");
  assert.deepEqual(ast.errors, [{ message: "expected command after 'then'", pos: 27 }]);
  assert.deepEqual(
    command.elif?.map((branch) => [branch.pos, branch.end, branch.then.pos, branch.then.end]),
    [
      [14, 26, 26, 26],
      [27, 41, 40, 41],
    ],
  );
  assert.equal(verify(source, ast), source);
});

test("thousands of elif branches serialize and print completely", () => {
  const source = "if :; then :;" + " elif :; then :;".repeat(4_999) + " elif final; then last; fi";
  const ast = parse(source);
  const command = nodeOfType(ast.commands[0].command, "If");
  assert.equal(ast.errors, undefined);
  assert.equal(command.elif?.length, 5_000);
  assert.equal(JSON.parse(JSON.stringify(ast)).commands[0].command.elif.length, 5_000);
  const printed = print(ast);
  assert.equal(printed.split("\nelif ").length, 5_001);
  assert.ok(printed.endsWith("\nelif final; then\n  last\nfi"));
});

test("flat elif conditions flush each heredoc after its then", () => {
  const source =
    "if cat <<'A'; then\na\nA\n  first\nelif cat <<'B'; then\nb\nB\n  second\nelif cat <<'C'; then\nc\nC\n  third\nfi";
  const ast = parse(source);
  const command = nodeOfType(ast.commands[0].command, "If");
  assert.equal(ast.errors, undefined);
  assert.equal(command.elif?.length, 2);
  assert.equal(verify(source, ast), source);
  assert.equal(
    print(ast),
    "if cat << 'A'; then\na\nA\n  first\nelif cat << 'B'; then\nb\nB\n  second\nelif cat << 'C'; then\nc\nC\n  third\nfi",
  );
});

test("logical test operands are flat and preserve source ranges", () => {
  const ast = parse("[[ a && b && c ]]");
  const expression = nodeOfType(ast.commands[0].command, "TestCommand").expression;
  assert.equal(ast.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(expression)), {
    type: "TestLogical",
    pos: 3,
    end: 14,
    operator: "&&",
    operands: [
      {
        type: "TestUnary",
        pos: 3,
        end: 4,
        operator: "-n",
        operand: { type: "Word", text: "a", pos: 3, end: 4, value: "a" },
      },
      {
        type: "TestUnary",
        pos: 8,
        end: 9,
        operator: "-n",
        operand: { type: "Word", text: "b", pos: 8, end: 9, value: "b" },
      },
      {
        type: "TestUnary",
        pos: 13,
        end: 14,
        operator: "-n",
        operand: { type: "Word", text: "c", pos: 13, end: 14, value: "c" },
      },
    ],
  });
  assert.equal(print(ast), "[[ -n a && -n b && -n c ]]");
});

test("flat logical tests preserve precedence and explicit groups", () => {
  const source = "[[ a && b && c || d && ( e || f ) ]]";
  const ast = parse(source);
  const expression = nodeOfType(nodeOfType(ast.commands[0].command, "TestCommand").expression, "TestLogical");
  assert.equal(ast.errors, undefined);
  assert.equal(expression.operator, "||");
  assert.equal(expression.operands?.length, 2);
  const left = nodeOfType(expression.operands[0], "TestLogical");
  const right = nodeOfType(expression.operands[1], "TestLogical");
  assert.equal(left.operator, "&&");
  assert.deepEqual(
    left.operands.map((operand) => nodeOfType(operand, "TestUnary").operand.text),
    ["a", "b", "c"],
  );
  assert.equal(right.operator, "&&");
  assert.equal(right.operands.length, 2);
  const group = nodeOfType(right.operands[1], "TestGroup");
  assert.deepEqual([group.pos, group.end], [23, 33]);
  const inner = nodeOfType(group.expression, "TestLogical");
  assert.equal(inner.operator, "||");
  assert.deepEqual(
    inner.operands.map((operand) => nodeOfType(operand, "TestUnary").operand.text),
    ["e", "f"],
  );
  assert.equal(verify(source, ast), source);
  assert.equal(print(ast), "[[ -n a && -n b && -n c || -n d && ( -n e || -n f ) ]]");
});

test("thousands of logical test operands serialize and print completely", () => {
  for (const operator of ["&&", "||"]) {
    const ast = parse("[[ a" + (" " + operator + " a").repeat(4_998) + " " + operator + " z ]]");
    const expression = nodeOfType(nodeOfType(ast.commands[0].command, "TestCommand").expression, "TestLogical");
    assert.equal(ast.errors, undefined);
    assert.equal(expression.operands?.length, 5_000);
    assert.equal(JSON.parse(JSON.stringify(expression)).operands.length, 5_000);
    const printed = print(ast);
    assert.equal(printed.split(" " + operator + " ").length, 5_000);
    assert.ok(printed.endsWith(" -n z ]]"));
  }
});

test("malformed test groups retain logical operands and following commands", () => {
  for (const [source, message, pos, printed] of [
    [
      "[[ a && ( b || c ]]; echo after",
      "expected ')' to close test group",
      19,
      "[[ -n a && ( -n b || -n c ) ]]\necho after",
    ],
    [
      "[[ ( -f ) && b ]]; echo after",
      "expected operand after unary test operator",
      7,
      "[[ ( -f ) && -n b ]]\necho after",
    ],
  ] as const) {
    const ast = parse(source);
    const expression = nodeOfType(nodeOfType(ast.commands[0].command, "TestCommand").expression, "TestLogical");
    assert.deepEqual(ast.errors, [{ message, pos }], source);
    assert.equal(expression.operands.length, 2, source);
    assert.equal(ast.commands.length, 2, source);
    assert.equal(print(ast), printed, source);
  }
});

test("pipeline prefixes are ordered records on one pipeline", () => {
  const source = "! time -p -- ! a | b";
  const ast = parse(source);
  const pipeline = nodeOfType(ast.commands[0].command, "Pipeline");
  assert.equal(ast.errors, undefined);
  assert.deepEqual(
    {
      range: [pipeline.pos, pipeline.end],
      prefixes: pipeline.prefixes.map((prefix) => ({ ...prefix })),
      commands: pipeline.commands.map((command) => nodeOfType(command, "Command").name?.text),
      operators: pipeline.operators,
    },
    {
      range: [0, 20],
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
        { type: "Negation", pos: 13, end: 14 },
      ],
      commands: ["a", "b"],
      operators: ["|"],
    },
  );
  assert.equal(verify(source, ast), source);
  assert.equal(print(ast), source);
});

test("a prefixed command or bare prefix is a pipeline, an unprefixed command is not", () => {
  const negated = nodeOfType(parse("! a").commands[0].command, "Pipeline");
  assert.deepEqual(
    [negated.pos, negated.end, negated.prefixes.length, negated.commands.map((c) => c.type), negated.operators],
    [0, 3, 1, ["Command"], []],
  );
  const bare = nodeOfType(parse("time").commands[0].command, "Pipeline");
  assert.deepEqual([bare.pos, bare.end, bare.prefixes[0].type, bare.commands, bare.operators], [0, 4, "Time", [], []]);
  assert.deepEqual(nodeOfType(parse("a | b").commands[0].command, "Pipeline").prefixes, []);
  assert.equal(parse("a").commands[0].command.type, "Command");
});

test("thousands of pipeline prefixes and test negations stay flat", () => {
  const prefixed = parse("! ".repeat(5000) + "a");
  assert.equal(prefixed.errors, undefined);
  assert.equal(nodeOfType(prefixed.commands[0].command, "Pipeline").prefixes.length, 5000);
  assert.equal(print(JSON.parse(JSON.stringify(prefixed))), "! ".repeat(5000) + "a");

  const negated = parse("[[ " + "! ".repeat(5000) + "-n x ]]");
  const testCommand = nodeOfType(negated.commands[0].command, "TestCommand");
  assert.equal(negated.errors, undefined);
  assert.equal(nodeOfType(testCommand.expression, "TestNot").negations.length, 5000);
  assert.equal(print(JSON.parse(JSON.stringify(negated))), "[[ " + "! ".repeat(5000) + "-n x ]]");
});

test("test negations are ordered records on one TestNot", () => {
  const source = "[[ ! ! -n x ]]";
  const ast = parse(source);
  const expression = nodeOfType(nodeOfType(ast.commands[0].command, "TestCommand").expression, "TestNot");
  assert.equal(ast.errors, undefined);
  assert.deepEqual(
    [expression.pos, expression.end, expression.negations.map((n) => ({ ...n })), expression.operand.type],
    [
      3,
      11,
      [
        { type: "Negation", pos: 3, end: 4 },
        { type: "Negation", pos: 5, end: 6 },
      ],
      "TestUnary",
    ],
  );
  assert.equal(verify(source, ast), source);
  assert.equal(print(ast), source);
});

test("if commands without elif branches have an empty elif list", () => {
  const command = nodeOfType(parse("if a; then b; else c; fi").commands[0].command, "If");
  assert.deepEqual(command.elif, []);
});
