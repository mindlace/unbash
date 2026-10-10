import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.ts";
import { nodeOfType } from "./ast-helpers.ts";
import { verify } from "./verify.ts";
import { WordImpl } from "../src/word.ts";

function markers(source: string): [string, string][] {
  const ast = parse(source);
  const result: [string, string][] = [];
  JSON.stringify(ast, (_key, value) => {
    if (value?.type === "Script") assert.equal(value.errors, undefined, source);
    if (value?.type === "Glob" || value?.type === "ExtendedGlob") result.push([value.type, value.text]);
    return value;
  });
  assert.equal(verify(source, ast), source);
  return result;
}

test("glob markers describe words independently of evaluation policy", () => {
  for (const source of [
    "echo *",
    "x=*",
    "export x=*",
    "cat <<< *",
    "case * in x) :;; esac",
    "[[ -f * ]]",
    "echo > *",
  ]) {
    assert.deepEqual(markers(source), [["Glob", "*"]], source);
  }
  assert.deepEqual(markers("set -f; echo *"), [["Glob", "*"]]);
});

test("arithmetic, indexes, regexes and heredoc text keep their own grammar", () => {
  for (const source of [
    "echo $((2*3))",
    "a[2*3]=x",
    "echo ${a[2*3]}",
    "echo ${a:2*3:4*5}",
    "[[ x =~ [ab].* ]]",
    "cat <<EOF\n* [ab]\nEOF",
  ]) {
    assert.deepEqual(markers(source), [], source);
  }
  assert.deepEqual(markers('a=([2*3]=*.js [4]="*" *)'), [
    ["Glob", "*"],
    ["Glob", "*"],
  ]);
});

test("parameter operands retain their quoting context", () => {
  assert.deepEqual(markers("echo ${x:-*.js}"), [["Glob", "*"]]);
  assert.deepEqual(markers('echo "${x:-*.js}"'), []);
  assert.deepEqual(markers('echo "${x#*.}" "${x/?.js/*.ts}" "${x^^[ab]}"'), [
    ["Glob", "*"],
    ["Glob", "?"],
    ["Glob", "*"],
    ["Glob", "[ab]"],
  ]);
  assert.deepEqual(markers("echo \"${x#'*.'}\""), []);
});

test("nested extglob operators are not plain wildcard markers", () => {
  assert.deepEqual(markers("echo @(a|*(b?))"), [
    ["ExtendedGlob", "@(a|*(b?))"],
    ["Glob", "?"],
  ]);
  assert.deepEqual(markers('echo "${v#*(a?)}"'), [["Glob", "?"]]);
});

test("brace bodies and continued extglobs expose wildcard children", () => {
  assert.deepEqual(markers("echo {a*,b?}"), [
    ["Glob", "*"],
    ["Glob", "?"],
  ]);
  assert.deepEqual(markers("echo @\\\n(*.js)"), [
    ["ExtendedGlob", "@\\\n(*.js)"],
    ["Glob", "*"],
  ]);
});

test("glob resolution preserves default Bash function and negation structure", () => {
  const source = "a*() { !(echo *.js); }";
  const ast = parse(source);
  const fn = nodeOfType(ast.commands[0].command, "Function");
  assert.equal(fn.name.value, "a*");
  assert.deepEqual(
    fn.name.parts?.map((part) => part.type),
    ["Literal", "Glob"],
  );
  const body = nodeOfType(fn.body, "BraceGroup");
  assert.equal(body.body.commands[0].command.type, "Negation");
  assert.deepEqual(markers(source), [
    ["Glob", "*"],
    ["Glob", "*"],
  ]);
});

test("plain value reads do not invoke lazy glob resolution", () => {
  let resolutions = 0;
  const word = new WordImpl("*.js", 4, 8, undefined, () => {
    resolutions++;
    return [
      { type: "Glob", kind: "star", pos: 4, end: 5, text: "*", value: "*", parts: undefined },
      { type: "Literal", pos: 5, end: 8, text: ".js", value: ".js" },
    ];
  });
  assert.equal(word.value, "*.js");
  assert.equal(resolutions, 0);
  assert.equal(word.parts?.[0].type, "Glob");
  assert.equal(word.parts?.[0].type, "Glob");
  assert.equal(resolutions, 1);
  assert.equal(word.value, "*.js");
});

test("intentionally unstructured words stay unstructured", () => {
  const word = new WordImpl("*[$x]", 0, 5);
  assert.equal(word.parts, undefined);
  assert.equal(word.value, "*[$x]");
});
