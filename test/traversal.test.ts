import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "../src/parser.ts";
import { forEachChild } from "../src/traversal.ts";
import type { ParsedScript, SyntaxNode } from "../src/types.ts";
import { nodeOfType } from "./ast-helpers.ts";

function collectNodes(root: SyntaxNode): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  function visit(node: SyntaxNode): void {
    nodes.push(node);
    forEachChild(node, visit);
  }
  visit(root);
  return nodes;
}

for (const [source, names] of [
  ["pnpm --filter=[$(git rev-parse HEAD~1)] exec pnpm pack", ["pnpm", "git"]],
  ['echo "$(quoted)" $"$(locale)"', ["echo", "quoted", "locale"]],
  [
    'echo "${x:-$(fallback)}" ${x#$(remove)} ${x/$(pattern)/$(replacement)} ${x:$(offset):$(length)} ${x^$(casepattern)} ${x[$(index)]}',
    ["echo", "fallback", "remove", "pattern", "replacement", "offset", "length", "casepattern", "index"],
  ],
  ["a[$(index)]=$(value)", ["index", "value"]],
  ["a=($(element) [$(index)]=$(value))", ["element", "index", "value"]],
  ["echo @($(extended)|x) {$(brace),y} [$(bracket)]", ["echo", "extended", "brace", "bracket"]],
  ["echo <(input) >(output)", ["echo", "input", "output"]],
  ["echo $(( $(condition) ? -$(yes) : ($(left)+$(right)) ))", ["echo", "condition", "yes", "left", "right"]],
  ["(( array[$(index)] + $(value) ))", ["index", "value"]],
  [
    "if condition; then yes; elif other; then alternative; else no; fi",
    ["condition", "yes", "other", "alternative", "no"],
  ],
  ["for x in $(items); do body; done", ["items", "body"]],
  ["select x in $(items); do body; done", ["items", "body"]],
  ["while condition; do body; done", ["condition", "body"]],
  ["for (( i=$(initial); i<$(limit); i+=$(step) )); do body; done", ["initial", "limit", "step", "body"]],
  ["case $(subject) in $(pattern)) action ;; *) fallback ;; esac", ["subject", "pattern", "action", "fallback"]],
  ["function f() { body; } >$(target); coproc worker { background; }", ["body", "target", "background"]],
  ["! time -p ( first ) | second && third || fourth", ["first", "second", "third", "fourth"]],
  ["[[ ! ! -n $(one) && ( $(two) == $(three) || -n $(four) ) ]]", ["one", "two", "three", "four"]],
  ["2>$(before) echo <<<$(input) >$(after)", ["echo", "before", "input", "after"]],
  ["cat <<EOF\n$(body)\nEOF", ["cat", "body"]],
] as const) {
  test(`recursive child traversal reaches commands in ${source}`, () => {
    const script = parse(source);
    assert.deepEqual(script.errors, undefined);
    const nodes = collectNodes(script);
    assert.deepEqual(
      nodes.flatMap((node) => (node.type === "Command" && node.name ? [node.name.value] : [])),
      names,
    );
    assert.equal(new Set(nodes).size, nodes.length);
    const serialized: ParsedScript = JSON.parse(JSON.stringify(script));
    assert.deepEqual(
      collectNodes(serialized).map((node) => [node.type, node.pos, node.end]),
      nodes.map((node) => [node.type, node.pos, node.end]),
    );
  });
}

test("child traversal visits only direct canonical children and ignores callback returns", () => {
  const script = parse("A=$(one) 2>$(two) cmd [$(three)] 3>$(four)");
  const command = nodeOfType(script.commands[0].command, "Command");
  Object.defineProperties(command, {
    args: { get: () => assert.fail("derived args must not be read") },
    redirects: { get: () => assert.fail("derived redirects must not be read") },
  });
  const children: [string, number, number][] = [];
  const result = forEachChild(command, (child) => {
    children.push([child.type, child.pos, child.end]);
    return false;
  });
  assert.equal(result, undefined);
  assert.deepEqual(children, [
    ["Assignment", 0, 8],
    ["Redirect", 9, 17],
    ["Word", 18, 21],
    ["Word", 22, 32],
    ["Redirect", 33, 42],
  ]);
});

test("parameter operations expose only their present operands", () => {
  const command = nodeOfType(parse("echo ${x@Q} ${!x@} ${x^} ${x:1} ${x!bad}").commands[0].command, "Command");
  const operations = command.args.map((argument) => {
    const parameter = nodeOfType(nodeOfType(argument, "Word").parts?.[0], "ParameterExpansion");
    assert.ok(parameter.operation);
    const operands: string[] = [];
    forEachChild(parameter.operation, (child) => operands.push(nodeOfType(child, "Word").text));
    return [parameter.operation.type, operands];
  });
  assert.deepEqual(operations, [
    ["Transform", ["Q"]],
    ["Names", []],
    ["CaseModification", []],
    ["Slice", ["1"]],
    ["Unknown", []],
  ]);
});

test("child traversal includes syntax records and excludes position-only records", () => {
  const script = parse("! time -p -- echo 3>out {fd}>other <<EOF\nbody\nEOF");
  assert.deepEqual(
    collectNodes(script).map((node) => node.type),
    [
      "Script",
      "Statement",
      "Pipeline",
      "Negation",
      "Time",
      "Command",
      "Word",
      "Redirect",
      "FileDescriptor",
      "Word",
      "Redirect",
      "FileDescriptorVariable",
      "Word",
      "HereDoc",
      "HereDocDelimiter",
      "HereDocBody",
    ],
  );
});

test("callers retain the source context when descending into decoded backticks", () => {
  const source = "echo `outer \\`inner cmd\\` tail`";
  const names: [string, number, number][] = [];
  function visit(node: SyntaxNode, owner: string): void {
    if (node.type === "Script" && node.source !== undefined) owner = node.source;
    if (node.type === "Command" && node.name) {
      names.push([owner.slice(node.name.pos, node.name.end), node.name.pos, node.name.end]);
    }
    forEachChild(node, (child) => visit(child, owner));
  }
  visit(parse(source), source);
  assert.deepEqual(names, [
    ["echo", 0, 4],
    ["outer", 0, 5],
    ["inner", 7, 12],
  ]);
});

for (const [type, source] of [
  ["ArithmeticExpansion", "echo $((" + "(".repeat(300) + "1" + ")".repeat(300) + "))"],
  ["CommandExpansion", "echo $(" + "{ ".repeat(300) + "value" + "; }".repeat(300) + ")"],
  ["ProcessSubstitution", "echo <(" + "{ ".repeat(300) + "value" + "; }".repeat(300) + ")"],
] as const) {
  test(`child traversal permits pruning before ${type} materialization`, () => {
    const script = parse(source);
    const visited: string[] = [];
    let expansion: SyntaxNode | undefined;
    function visit(node: SyntaxNode): void {
      visited.push(node.type);
      if (node.type === type) {
        expansion = node;
        return;
      }
      forEachChild(node, visit);
    }
    assert.doesNotThrow(() => visit(script));
    assert.deepEqual(visited, ["Script", "Statement", "Command", "Word", "Word", type]);
    const deferred = nodeOfType(expansion, type);
    // The scanner reports arithmetic depth while parsing; embedded scripts report on themselves.
    const reported: ParsedScript["errors"] =
      type === "ArithmeticExpansion"
        ? [{ message: "maximum arithmetic expression nesting depth exceeded", pos: 264 }]
        : undefined;
    assert.deepEqual(script.errors, reported);
    const children: SyntaxNode[] = [];
    forEachChild(deferred, (child) => children.push(child));
    assert.equal(children.length, 1);
    assert.equal(children[0].type, type === "ArithmeticExpansion" ? "ArithmeticGroup" : "Script");
    for (let read = 0; read < 2; read++) {
      const repeated: SyntaxNode[] = [];
      forEachChild(deferred, (child) => repeated.push(child));
      assert.equal(repeated.length, children.length);
      for (let i = 0; i < children.length; i++) assert.equal(repeated[i], children[i]);
      assert.deepEqual(script.errors, reported);
      if (type !== "ArithmeticExpansion") assert.equal(nodeOfType(children[0], "Script").errors?.length, 1);
    }
  });
}

test("child traversal propagates callback failures without visiting later siblings", () => {
  const command = nodeOfType(parse("cmd first second").commands[0].command, "Command");
  const error = new Error("consumer failure");
  let calls = 0;
  assert.throws(
    () =>
      forEachChild(command, () => {
        calls++;
        throw error;
      }),
    (caught) => caught === error,
  );
  assert.equal(calls, 1);
});

test("stopping from the callback costs the remaining siblings along the path and nothing below them", () => {
  const script = parse("first $(one) $(two)\n" + "later $(three)\n".repeat(20));
  const visited: string[] = [];
  let calls = 0;
  let stopped = false;
  function visit(node: SyntaxNode): void {
    calls++;
    if (stopped) return;
    visited.push(node.type);
    if (node.type === "CommandExpansion") {
      stopped = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(script);
  assert.deepEqual(visited, ["Script", "Statement", "Command", "Word", "Word", "CommandExpansion"]);
  // One remaining suffix word and twenty remaining statements reach the callback; their subtrees do not.
  assert.equal(calls, visited.length + 1 + 20);
});

const fixturesDir = join(import.meta.dirname, "../fixtures");

function* fixtureSources(): Generator<[string, string]> {
  for (const subdir of readdirSync(fixturesDir)) {
    for (const file of readdirSync(join(fixturesDir, subdir))) {
      const source = readFileSync(join(fixturesDir, subdir, file), "utf8");
      if (subdir !== "tree-sitter-corpus") {
        yield [`${subdir}/${file}`, source];
        continue;
      }
      const sections = source.split(/^={3,}$/m);
      for (let i = 2; i < sections.length; i += 2) {
        yield [`${subdir}/${file}#${i / 2}`, sections[i].split(/^-{3,}$/m)[0].replace(/^\n/, "")];
      }
    }
  }
}

// The switch owns child enumeration; this guards its fields, which `never` exhaustiveness cannot.
test("child enumeration reaches every serialized syntax node once, in order, with stable identity", () => {
  let total = 0;
  for (const [name, source] of fixtureSources()) {
    const script = parse(source);
    const reached: string[] = [];
    const seen = new Set<SyntaxNode>();
    function visit(node: SyntaxNode): void {
      assert.equal(seen.has(node), false, `${name}: ${node.type} at ${node.pos} reached twice`);
      seen.add(node);
      reached.push(`${node.type}@${node.pos}-${node.end}`);
      const children: SyntaxNode[] = [];
      forEachChild(node, (child) => children.push(child));
      let index = 0;
      let previous = -1;
      forEachChild(node, (child) => {
        assert.equal(child, children[index], `${name}: ${node.type} child ${index} changed between calls`);
        assert.ok(child.pos >= previous, `${name}: ${node.type} children out of source order`);
        previous = child.pos;
        index++;
      });
      assert.equal(index, children.length);
      for (const child of children) visit(child);
    }
    visit(script);
    const serialized: string[] = [];
    (function collect(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) collect(item);
        return;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.type === "string") serialized.push(`${record.type}@${record.pos}-${record.end}`);
      for (const key of Object.keys(record)) collect(record[key]);
    })(JSON.parse(JSON.stringify(script)));
    assert.deepEqual(reached.sort(), serialized.sort(), name);
    total += reached.length;
  }
  assert.ok(total > 100_000, `${total} nodes`);
});
