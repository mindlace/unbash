import assert from "node:assert/strict";
import test from "node:test";
import { computeWordParts } from "../src/parts.ts";
import { parse } from "../src/parser.ts";
import { nodeOfType } from "./ast-helpers.ts";

test("parts construction does not rescan a plain prefix for globs", () => {
  const source = "a".repeat(1024) + '"$x"';
  const charCodeAt = String.prototype.charCodeAt;
  let reads = 0;
  String.prototype.charCodeAt = function (index: number): number {
    if (this === source && index < 1024) reads++;
    return charCodeAt.call(this, index);
  };
  try {
    const parts = computeWordParts(source, { pos: 0, end: source.length });
    assert.deepEqual(
      parts?.map((part) => part.type),
      ["Literal", "DoubleQuoted"],
    );
  } finally {
    String.prototype.charCodeAt = charCodeAt;
  }
  assert.ok(reads < 2500, `plain prefix read ${reads} times`);
});

test("lazy glob candidates survive quotes, escapes and nested scans", () => {
  for (const [source, expected] of [
    ['echo a"*"b', []],
    [String.raw`echo a\*b`, []],
    ['echo a"*"b?', ["?"]],
    ['echo ["a"]', ['["a"]']],
    ["echo ${x:-*}suffix?", ["*", "?"]],
    ['echo prefix*"${x:-plain}"', ["*"]],
    ['echo "${x:-*}"suffix?', ["?"]],
    ["echo <(printf '*')suffix?", ["?"]],
    ["a=([2*3]=plain [4]=file?)", ["?"]],
    ["echo {plain,*.js}suffix?", ["*", "?"]],
    ["echo @(*.js|plain)suffix?", ["*", "?"]],
  ] as const) {
    const ast = parse(source);
    const found: string[] = [];
    JSON.stringify(ast, (_key, value) => {
      if (value?.type === "Script") assert.equal(value.errors, undefined, source);
      if (value?.type === "Glob") found.push(value.text);
      return value;
    });
    assert.deepEqual(found, expected, source);
  }
});

test("value and parts agree when a quoted word has no unquoted glob", () => {
  const ast = parse('echo pre"*"post');
  const word = nodeOfType(nodeOfType(ast.commands[0].command, "Command").args[0], "Word");
  assert.equal(word.value, "pre*post");
  assert.deepEqual(
    word.parts?.map((part) => part.type),
    ["Literal", "DoubleQuoted", "Literal"],
  );
  assert.equal(word.value, "pre*post");
});
