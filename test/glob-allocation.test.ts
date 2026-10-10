import assert from "node:assert/strict";
import test from "node:test";
import { parseGlobParts } from "../src/glob.ts";
import { parse } from "../src/parser.ts";
import { nodeOfType } from "./ast-helpers.ts";

function bracketAllocations(action: () => void): number {
  const MapConstructor = globalThis.Map;
  const Int32ArrayConstructor = globalThis.Int32Array;
  let allocations = 0;
  function track<T extends typeof Map | typeof Int32Array>(constructor: T): T {
    return new Proxy(constructor, {
      construct(target, args) {
        allocations++;
        return Reflect.construct(target, args);
      },
    });
  }
  globalThis.Map = track(MapConstructor);
  globalThis.Int32Array = track(Int32ArrayConstructor);
  try {
    action();
  } finally {
    globalThis.Map = MapConstructor;
    globalThis.Int32Array = Int32ArrayConstructor;
  }
  return allocations;
}

test("a lone bracket command does not allocate bracket-matching tables", () => {
  const ast = parse("[ -f file ]");
  const command = nodeOfType(ast.commands[0].command, "Command");
  assert.equal(command.name?.value, "[");
  assert.equal(
    bracketAllocations(() => assert.equal(command.name?.parts, undefined)),
    0,
  );
});

test("bracket lookahead remains within its source window", () => {
  const source = "prefix[xxxxxxxx]";
  const charCodeAt = String.prototype.charCodeAt;
  const indexOf = String.prototype.indexOf;
  let outOfRangeReads = 0;
  let unboundedSearches = 0;
  String.prototype.charCodeAt = function (index: number): number {
    if (String(this) === source && (index < 6 || index >= 7)) outOfRangeReads++;
    return charCodeAt.call(this, index);
  };
  String.prototype.indexOf = function (search: string, position?: number): number {
    if (String(this) === source && search === "]") unboundedSearches++;
    return indexOf.call(this, search, position);
  };
  let allocations: number;
  try {
    allocations = bracketAllocations(() => assert.equal(parseGlobParts(source, 6, 7, undefined), undefined));
  } finally {
    String.prototype.charCodeAt = charCodeAt;
    String.prototype.indexOf = indexOf;
  }
  assert.equal(allocations, 0);
  assert.equal(outOfRangeReads, 0);
  assert.equal(unboundedSearches, 0);
});

test("unmatched opening brackets share one bounded lookahead", () => {
  function characterReads(size: number): number {
    const source = "[".repeat(size) + "x*";
    const charCodeAt = String.prototype.charCodeAt;
    let reads = 0;
    String.prototype.charCodeAt = function (index: number): number {
      reads++;
      return charCodeAt.call(this, index);
    };
    try {
      const parts = parseGlobParts(source, 0, source.length, undefined);
      assert.equal(parts?.length, 2);
      assert.equal(parts?.[0].type, "Literal");
      assert.equal(parts?.[1].type, "Glob");
      assert.equal(parts?.[1].text, "*");
    } finally {
      String.prototype.charCodeAt = charCodeAt;
    }
    return reads;
  }
  assert.ok(characterReads(4096) < characterReads(2048) * 2.1);
  assert.equal(
    bracketAllocations(() => characterReads(4096)),
    0,
  );
});
