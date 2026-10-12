import { nodeOfType } from "./ast-helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.ts";
import { computeWordParts } from "../src/parts.ts";
import { print } from "../src/printer.ts";

const getCmd = (ast: ReturnType<typeof parse>, i = 0) => nodeOfType(ast.commands[i].command, "Command");
const wp = (s: string, w: import("../src/types.ts").Word) => computeWordParts(s, w);

test("command-start bang preserves default Bash's negated subshell", () => {
  const ast = parse("!(echo RAN-INSIDE)");
  assert.equal(ast.errors, undefined);
  const negation = nodeOfType(ast.commands[0].command, "Negation");
  assert.deepEqual([negation.pos, negation.keywordEnd, negation.end], [0, 1, 18]);
  const subshell = nodeOfType(negation.command, "Subshell");
  assert.deepEqual([subshell.pos, subshell.end], [1, 18]);
  const command = nodeOfType(subshell.body.commands[0].command, "Command");
  assert.equal(command.name?.text, "echo");
  assert.deepEqual(
    command.args.map((arg) => arg.text),
    ["RAN-INSIDE"],
  );
});

test("negated subshells retain their structure in nested scripts and conditions", () => {
  for (const [source, expectedNames, expectedNegations] of [
    ["echo $( !(echo nested) )", ["echo", "echo"], 1],
    ["echo <(!(echo nested))", ["echo", "echo"], 1],
    ["if !(echo nested); then echo yes; fi", ["echo", "echo"], 1],
    ["time !(echo nested)", ["echo"], 1],
    ["true && !(echo nested)", ["true", "echo"], 1],
    ["!(!(echo nested))", ["echo"], 2],
    ["!\\\n(echo nested)", ["echo"], 1],
  ] as const) {
    const ast = parse(source);
    const tree = JSON.parse(JSON.stringify(ast));
    const names: string[] = [];
    const errors: unknown[] = [];
    let negations = 0;
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if ("errors" in value) errors.push(value.errors);
      if ("type" in value && value.type === "Negation") negations++;
      if ("type" in value && value.type === "Command" && "name" in value) {
        names.push((value.name as { text: string }).text);
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(tree);
    assert.deepEqual(errors, [], source);
    assert.deepEqual(names, expectedNames, source);
    assert.equal(negations, expectedNegations, source);
  }
});

test("function names ending in extglob operators follow default Bash", () => {
  for (const name of ["x@", "a*", "x+", "x?", "x!", "@", "*", "+", "?"]) {
    for (const parens of ["()", "( \t)", "\\\n(\\\n)"]) {
      const source = `${name}${parens} { echo body; }`;
      const ast = parse(source);
      assert.equal(ast.errors, undefined, source);
      const fn = nodeOfType(ast.commands[0].command, "Function");
      assert.equal(fn.name.value, name, source);
      assert.equal(fn.name.parts?.some((part) => part.type === "ExtendedGlob") ?? false, false, source);
      assert.equal(computeWordParts(source, fn.name), undefined, source);
      const body = nodeOfType(fn.body, "BraceGroup");
      assert.equal(nodeOfType(body.body.commands[0].command, "Command").name?.text, "echo", source);
    }
  }
});

test("the function keyword preserves operator-ending names and subshell bodies", () => {
  for (const source of ["function x@() { echo body; }", "function x@(echo body)", "function x@() (echo body)"]) {
    const ast = parse(source);
    assert.equal(ast.errors, undefined, source);
    const fn = nodeOfType(ast.commands[0].command, "Function");
    assert.equal(fn.name.text, "x@", source);
    assert.equal(fn.name.parts, undefined, source);
    const body = nodeOfType(fn.body, "BraceGroup", "Subshell");
    assert.equal(nodeOfType(body.body.commands[0].command, "Command").name?.text, "echo", source);
  }
});

test("negated and empty extglobs remain patterns in case arms", () => {
  const ast = parse("case x in !(bad)) echo first;; @()) echo second;; esac");
  assert.equal(ast.errors, undefined);
  const command = nodeOfType(ast.commands[0].command, "Case");
  assert.deepEqual(
    command.items.map((item) => item.pattern.map((word) => word.text)),
    [["!(bad)"], ["@()"]],
  );
  assert.deepEqual(
    command.items.map((item) => item.pattern[0].parts?.[0].type),
    ["ExtendedGlob", "ExtendedGlob"],
  );
});

test("empty extglobs remain words outside function-name position", () => {
  const ast = parse("echo @() !() x@()");
  assert.equal(ast.errors, undefined);
  assert.deepEqual(
    getCmd(ast).args.map((word) => word.text),
    ["@()", "!()", "x@()"],
  );
  assert.deepEqual(
    getCmd(ast).args.map((word) => nodeOfType(word, "Word").parts?.at(-1)?.type),
    ["ExtendedGlob", "ExtendedGlob", "ExtendedGlob"],
  );
});

test("conditional patterns keep extglobs with default shell options", () => {
  const ast = parse("[[ x == !(bad) ]]");
  assert.equal(ast.errors, undefined);
  const command = nodeOfType(ast.commands[0].command, "TestCommand");
  const expression = nodeOfType(command.expression, "TestBinary");
  const pattern = nodeOfType(expression.right.parts?.[0], "ExtendedGlob");
  assert.deepEqual([pattern.operator, pattern.pattern], ["!", "bad"]);
});

test("command syntax takes precedence even when its body is incomplete", () => {
  assert.deepEqual(parse("@()").errors, [{ message: "expected compound command as function body", pos: 3 }]);
  assert.deepEqual(parse("!(foo)bar").errors, [{ message: "unexpected token 'bar'", pos: 6 }]);
  const ast = parse("./!(foo)bar");
  assert.equal(ast.errors, undefined);
  const name = getCmd(ast).name!;
  assert.equal(name.text, "./!(foo)bar");
  assert.equal(nodeOfType(name.parts?.[1], "ExtendedGlob").pattern, "foo");
});

test("default command syntax rejects ambiguous assignment and coproc spellings", () => {
  for (const source of ["a=@()", "a=x@()", "!()", "coproc !(echo)"]) {
    assert.ok(parse(source).errors?.length, source);
  }
});

test("assignment and redirect prefixes retain command-word interpretation", () => {
  for (const source of ["A=1 ! echo", ">out ! echo"]) {
    const ast = parse(source);
    assert.equal(ast.errors, undefined, source);
    const command = getCmd(ast);
    assert.equal(command.name?.text, "!", source);
    assert.deepEqual(
      command.args.map((arg) => arg.text),
      ["echo"],
      source,
    );
  }
  for (const source of ["A=1 !(echo)", ">out !(echo)"]) {
    const ast = parse(source);
    assert.equal(ast.errors, undefined, source);
    assert.equal(nodeOfType(getCmd(ast).name?.parts?.[0], "ExtendedGlob").pattern, "echo", source);
  }
});

test("only shell blanks and continuations make an empty function parameter list", () => {
  for (const [source, expected] of [
    ["x@(\n)", "\n"],
    ["x@(\r)", "\r"],
    ["x@(\\ )", "\\ "],
    ["x@('')", "''"],
    ["x@(#)", "#"],
  ]) {
    const ast = parse(source);
    assert.equal(ast.errors, undefined, source);
    assert.equal(nodeOfType(getCmd(ast).name?.parts?.[1], "ExtendedGlob").pattern, expected, source);
  }
  const ast = parse("x@( \t\\\n \t) { :; }");
  assert.equal(ast.errors, undefined);
  assert.equal(nodeOfType(ast.commands[0].command, "Function").name.text, "x@");
});

test("negated subshells and operator-ending functions retain their meaning when printed", () => {
  for (const [source, expected] of [
    ["!(echo RAN-INSIDE)", "! (echo RAN-INSIDE)"],
    ["x@() { :; }", "x@() {\n  :\n}"],
    ["function x=() { :; }", "function x= {\n  :\n}"],
  ]) {
    const ast = parse(source);
    assert.equal(ast.errors, undefined, source);
    assert.equal(print(ast), expected, source);
    assert.equal(print(JSON.parse(JSON.stringify(ast))), expected, source);
    const reparsed = parse(expected);
    assert.equal(reparsed.errors, undefined, source);
    assert.equal(print(reparsed), expected, source);
  }
});

// ── Extglob operators ────────────────────────────────────────────────

test("extglob !(pattern)", () => {
  const src = "echo !(*.txt)";
  const c = getCmd(parse(src));
  const part = nodeOfType(wp(src, nodeOfType(c.suffix[0], "Word"))![0], "ExtendedGlob");
  assert.equal(part.type, "ExtendedGlob");
  assert.equal(part.operator, "!");
  assert.equal(part.pattern, "*.txt");
});

test("extglob @(a|b|c)", () => {
  const src = "echo @(foo|bar|baz)";
  const c = getCmd(parse(src));
  const part = nodeOfType(wp(src, nodeOfType(c.suffix[0], "Word"))![0], "ExtendedGlob");
  assert.equal(part.type, "ExtendedGlob");
  assert.equal(part.operator, "@");
  assert.equal(part.pattern, "foo|bar|baz");
});

test("extglob ?(pattern)", () => {
  const src = "echo ?(pre)fix";
  const c = getCmd(parse(src));
  const parts = wp(src, nodeOfType(c.suffix[0], "Word"))!;
  assert.equal(parts[0].type, "ExtendedGlob");
  assert.equal(nodeOfType(parts[0], "ExtendedGlob").operator, "?");
  assert.equal(parts[1].type, "Literal");
  assert.equal(nodeOfType(parts[1], "Literal").value, "fix");
});

test("extglob +(pattern)", () => {
  const src = "echo +(digit)";
  const c = getCmd(parse(src));
  assert.equal(wp(src, nodeOfType(c.suffix[0], "Word"))![0].type, "ExtendedGlob");
  assert.equal(nodeOfType(wp(src, nodeOfType(c.suffix[0], "Word"))![0], "ExtendedGlob").operator, "+");
});

test("extglob *(pattern)", () => {
  const src = "echo *(any)thing";
  const c = getCmd(parse(src));
  assert.equal(wp(src, nodeOfType(c.suffix[0], "Word"))![0].type, "ExtendedGlob");
  assert.equal(nodeOfType(wp(src, nodeOfType(c.suffix[0], "Word"))![0], "ExtendedGlob").operator, "*");
});

test("extglob text preserved", () => {
  const c = getCmd(parse("echo !(*.log|*.tmp)"));
  assert.equal(nodeOfType(c.suffix[0], "Word").text, "!(*.log|*.tmp)");
});

test("extglob with literal prefix", () => {
  const src = "echo file_!(*.bak)";
  const c = getCmd(parse(src));
  const parts = wp(src, nodeOfType(c.suffix[0], "Word"))!;
  assert.equal(parts[0].type, "Literal");
  assert.equal(nodeOfType(parts[0], "Literal").value, "file_");
  assert.equal(parts[1].type, "ExtendedGlob");
});

test("pathname-prefixed extglob stays inside nested rm command (#313; Bash -O extglob)", () => {
  const source = `function check_pools() { (
    shopt -s nullglob extglob
    rm -fv /etc/php/*/fpm/pool.d/!(*.conf|*.orig|*.dpkg-dist)
); }`;
  const ast = parse(source);
  assert.equal(ast.errors, undefined);
  const fn = ast.commands[0].command;
  assert.deepEqual([fn.type, fn.pos, fn.end], ["Function", 0, 123]);
  if (fn.type !== "Function") return;
  assert.equal(fn.body.type, "BraceGroup");
  if (fn.body.type !== "BraceGroup") return;
  const subshell = fn.body.body.commands[0].command;
  assert.deepEqual([subshell.type, subshell.pos, subshell.end], ["Subshell", 25, 120]);
  if (subshell.type !== "Subshell") return;
  assert.equal(subshell.body.commands.length, 2);
  const rm = subshell.body.commands[1].command;
  assert.deepEqual([rm.type, rm.pos, rm.end, rm.type === "Command" && rm.name?.text], ["Command", 61, 118, "rm"]);
  if (rm.type !== "Command") return;
  const path = nodeOfType(rm.suffix[1], "Word");
  assert.deepEqual([path.text, path.pos, path.end], ["/etc/php/*/fpm/pool.d/!(*.conf|*.orig|*.dpkg-dist)", 68, 118]);
  assert.deepEqual(wp(source, path), [
    { type: "Literal", pos: 68, end: 90, value: "/etc/php/*/fpm/pool.d/", text: "/etc/php/*/fpm/pool.d/" },
    {
      type: "ExtendedGlob",
      pos: 90,
      end: 118,
      text: "!(*.conf|*.orig|*.dpkg-dist)",
      operator: "!",
      pattern: "*.conf|*.orig|*.dpkg-dist",
      parts: undefined,
    },
  ]);
});

test("=(pattern) is NOT extglob (used for array assignment)", () => {
  const c = getCmd(parse("x=(a b c)"));
  assert.equal(c.prefix.length, 1);
  assert.equal(c.prefix[0].type, "Assignment");
});

// ── Text preservation ────────────────────────────────────────────────

test("extglob ?() preserved in word", () => {
  const c = getCmd(parse("ls ?(foo|bar)"));
  assert.deepEqual(
    c.suffix.map((s) => nodeOfType(s, "Word").text),
    ["?(foo|bar)"],
  );
});

test("extglob @() preserved in word", () => {
  const c = getCmd(parse("ls @(a|b|c)"));
  assert.deepEqual(
    c.suffix.map((s) => nodeOfType(s, "Word").text),
    ["@(a|b|c)"],
  );
});

test("extglob *() preserved in word", () => {
  const c = getCmd(parse("ls *(pat)"));
  assert.deepEqual(
    c.suffix.map((s) => nodeOfType(s, "Word").text),
    ["*(pat)"],
  );
});

test("extglob +() preserved in word", () => {
  const c = getCmd(parse("ls +(x|y)"));
  assert.deepEqual(
    c.suffix.map((s) => nodeOfType(s, "Word").text),
    ["+(x|y)"],
  );
});

test("extglob !() preserved in word", () => {
  const c = getCmd(parse("ls !(bad)"));
  assert.deepEqual(
    c.suffix.map((s) => nodeOfType(s, "Word").text),
    ["!(bad)"],
  );
});

test("nested extglob preserved", () => {
  const c = getCmd(parse("ls @(a|+(b|c))"));
  assert.deepEqual(
    c.suffix.map((s) => nodeOfType(s, "Word").text),
    ["@(a|+(b|c))"],
  );
});

test("case is literal inside an extended glob", () => {
  const src = "echo @(case|foo) tail";
  const c = getCmd(parse(src));
  assert.deepEqual(
    c.suffix.map((word) => nodeOfType(word, "Word").text),
    ["@(case|foo)", "tail"],
  );
});

// ── Tokenizer disambiguation ─────────────────────────────────────────

test("extglob @() not confused with subshell", () => {
  const c = getCmd(parse("ls @(a|b)"));
  assert.deepEqual(
    c.suffix.map((s) => nodeOfType(s, "Word").text),
    ["@(a|b)"],
  );
});

test("extglob !() not confused with negation", () => {
  const c = getCmd(parse("ls !(bad)"));
  assert.deepEqual(
    c.suffix.map((s) => nodeOfType(s, "Word").text),
    ["!(bad)"],
  );
});

test("nested extglob in tokenizer", () => {
  const c = getCmd(parse("ls @(a|+(b|c))"));
  assert.deepEqual(
    c.suffix.map((s) => nodeOfType(s, "Word").text),
    ["@(a|+(b|c))"],
  );
});

test("extglob in [[ ]] condition", () => {
  const ast = parse("[[ ${f} != */@(default).vim ]]");
  assert.ok(ast.commands.length > 0);
});

test("command substitutions inside extended globs remain structured", () => {
  const src = "echo @($(one)|safe$(two))";
  const c = getCmd(parse(src));
  const part = wp(src, nodeOfType(c.suffix[0], "Word"))![0];
  assert.equal(part.type, "ExtendedGlob");
  if (part.type !== "ExtendedGlob") return;
  const expansions = part.parts?.filter((child) => child.type === "CommandExpansion") ?? [];
  assert.deepEqual(
    expansions.map((expansion) => {
      if (expansion.type !== "CommandExpansion") return undefined;
      const command = expansion.script?.commands[0].command;
      return command?.type === "Command" ? command.name?.value : undefined;
    }),
    ["one", "two"],
  );
});

test("process substitutions inside extended globs remain structured", () => {
  const src = "echo @(<(danger)|safe)";
  const c = getCmd(parse(src));
  const part = wp(src, nodeOfType(c.suffix[0], "Word"))![0];
  assert.equal(part.type, "ExtendedGlob");
  if (part.type !== "ExtendedGlob") return;
  const expansion = part.parts?.find((child) => child.type === "ProcessSubstitution");
  assert.equal(expansion?.type, "ProcessSubstitution");
  if (expansion?.type !== "ProcessSubstitution") return;
  const command = expansion.script?.commands[0].command;
  assert.equal(command?.type, "Command");
  if (command?.type === "Command") assert.equal(command.name?.value, "danger");
});

test("closing parentheses inside substitutions do not truncate extended globs", () => {
  const src = 'echo @($(printf ")")|safe)';
  const c = getCmd(parse(src));
  const part = wp(src, nodeOfType(c.suffix[0], "Word"))![0];
  assert.equal(part.type, "ExtendedGlob");
  if (part.type !== "ExtendedGlob") return;
  assert.equal(part.pattern, '$(printf ")")|safe');
  const expansion = part.parts?.find((child) => child.type === "CommandExpansion");
  assert.equal(expansion?.type, "CommandExpansion");
  if (expansion?.type !== "CommandExpansion") return;
  const command = expansion.script?.commands[0].command;
  assert.equal(command?.type, "Command");
  if (command?.type === "Command") assert.equal(command.name?.value, "printf");
});

test("unterminated extended globs report an error without truncating nested substitutions", () => {
  const src = "echo @(safe|$(danger)";
  const ast = parse(src);
  const c = getCmd(ast);
  const part = wp(src, nodeOfType(c.suffix[0], "Word"))![0];
  assert.equal(part.type, "ExtendedGlob");
  if (part.type !== "ExtendedGlob") return;
  const expansion = part.parts?.find((child) => child.type === "CommandExpansion");
  assert.equal(expansion?.type, "CommandExpansion");
  if (expansion?.type !== "CommandExpansion") return;
  const command = expansion.script?.commands[0].command;
  assert.equal(command?.type, "Command");
  if (command?.type === "Command") assert.equal(command.name?.value, "danger");
  assert.ok(ast.errors?.some((error) => error.message === "unterminated extended glob"));
});
