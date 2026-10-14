import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.ts";
import { print } from "../src/printer.ts";
import { parseGlobParts } from "../src/glob.ts";
import type { WordPart } from "../src/types.ts";
import { arrayElements, nodeOfType } from "./ast-helpers.ts";

function argument(source: string, index = 0) {
  const ast = parse(source);
  assert.equal(ast.errors, undefined);
  return nodeOfType(nodeOfType(ast.commands[0].command, "Command").suffix[index], "Word");
}

test("plain wildcard words expose source-positioned glob parts lazily", () => {
  const word = argument("echo dir/**/file?.js");
  assert.equal(word.value, "dir/**/file?.js");
  assert.deepEqual(word.parts, [
    { type: "Literal", pos: 5, end: 9, text: "dir/", value: "dir/" },
    { type: "Glob", kind: "star", pos: 9, end: 11, text: "**", value: "**", parts: undefined },
    { type: "Literal", pos: 11, end: 16, text: "/file", value: "/file" },
    { type: "Glob", kind: "question", pos: 16, end: 17, text: "?", value: "?", parts: undefined },
    { type: "Literal", pos: 17, end: 20, text: ".js", value: ".js" },
  ]);
  assert.equal(word.value, "dir/**/file?.js");
});

test("plain brackets own literal interiors without nested wildcard operators", () => {
  const word = argument("echo [a*?]");
  assert.deepEqual(word.parts, [
    {
      type: "Glob",
      kind: "bracket",
      pos: 5,
      end: 10,
      text: "[a*?]",
      value: "[a*?]",
      parts: [{ type: "Literal", pos: 6, end: 9, text: "a*?", value: "a*?" }],
    },
  ]);
});

test("glob values preserve escaped bracket decoding during word reconstruction", () => {
  const word = argument(String.raw`echo [a\ b]$(pwd)`);
  assert.deepEqual(word.parts?.[0], {
    type: "Glob",
    kind: "bracket",
    pos: 5,
    end: 11,
    text: String.raw`[a\ b]`,
    value: "[a b]",
    parts: [{ type: "Literal", pos: 6, end: 10, text: String.raw`a\ b`, value: "a b" }],
  });
  assert.equal(word.value, "[a b]$(pwd)");
  assert.equal(word.parts?.map((part) => ("value" in part ? part.value : part.text)).join(""), "[a b]$(pwd)");
});

test("glob values do not read embedded script or arithmetic payloads", () => {
  const source = "[$(cmd)$((1+2))]";
  const parts = parseGlobParts(source, 0, source.length, [
    {
      type: "CommandExpansion",
      pos: 1,
      end: 7,
      text: "$(cmd)",
      get script(): never {
        throw new Error("script accessed");
      },
    },
    {
      type: "ArithmeticExpansion",
      pos: 7,
      end: 15,
      text: "$((1+2))",
      get expression(): never {
        throw new Error("expression accessed");
      },
    },
  ]);
  const glob = nodeOfType(parts?.[0], "Glob");
  assert.equal(glob.kind, "bracket");
  assert.equal(glob.value, "[$(cmd)$((1+2))]");
  assert.deepEqual(
    glob.parts?.map((part) => part.type),
    ["CommandExpansion", "ArithmeticExpansion"],
  );
});

test("quotes and escapes protect wildcard characters", () => {
  for (const spelling of [String.raw`\*\?\[ab]`, "'*?[ab]'", '"*?[ab]"', "$'*?[ab]'"]) {
    const word = argument(`echo ${spelling}`);
    assert.equal(word.parts?.some((part) => part.type === "Glob") ?? false, false);
    assert.equal(word.value, "*?[ab]");
  }
});

test("mixed quoting keeps globs and dequoted literal values", () => {
  const word = argument(String.raw`echo 'dir/'a\ b*.js`);
  assert.deepEqual(
    word.parts?.map((part) => [part.type, part.text]),
    [
      ["SingleQuoted", "'dir/'"],
      ["Literal", String.raw`a\ b`],
      ["Glob", "*"],
      ["Literal", ".js"],
    ],
  );
  assert.equal(word.value, "dir/a b*.js");
});

test("bracket expressions recognize classes, negation and an initial close bracket", () => {
  for (const [spelling, value, interior, interiorValue] of [
    ["[ab]", "[ab]", "ab", "ab"],
    ["[!a-z]", "[!a-z]", "!a-z", "!a-z"],
    ["[^a-z]", "[^a-z]", "^a-z", "^a-z"],
    ["[]a]", "[]a]", "]a", "]a"],
    ["[!]]", "[!]]", "!]", "!]"],
    ["[[:alpha:]]", "[[:alpha:]]", "[:alpha:]", "[:alpha:]"],
    ["[[.x.]]", "[[.x.]]", "[.x.]", "[.x.]"],
    ["[[=a=]]", "[[=a=]]", "[=a=]", "[=a=]"],
    [String.raw`[\]]`, "[]]", String.raw`\]`, "]"],
  ]) {
    const word = argument(`echo ${spelling}`);
    assert.deepEqual(word.parts, [
      {
        type: "Glob",
        kind: "bracket",
        pos: 5,
        end: 5 + spelling.length,
        text: spelling,
        value,
        parts: [
          {
            type: "Literal",
            pos: 6,
            end: 4 + spelling.length,
            text: interior,
            value: interiorValue,
          },
        ],
      },
    ]);
  }
});

test("bracket members honor escapes and continued syntax", () => {
  for (const spelling of [String.raw`[\!a]`, String.raw`[a\]]`, "[\\\n!a]", "[[\\\n:alpha:]]"]) {
    const word = argument(`echo ${spelling}`);
    assert.deepEqual(
      word.parts?.map((part) => [part.type, part.text]),
      [["Glob", spelling]],
    );
  }
  assert.equal(argument(String.raw`echo [a\]]`).value, "[a]]");
  assert.equal(argument("echo [\\\n!a]").value, "[!a]");
});

test("unmatched brackets stay literal while later wildcards remain visible", () => {
  for (const spelling of ["[", "[]", "[!", "[!]"]) assert.equal(argument(`echo ${spelling}`).parts, undefined);
  assert.deepEqual(
    argument("echo [file*").parts?.map((part) => [part.type, part.text]),
    [
      ["Literal", "[file"],
      ["Glob", "*"],
    ],
  );
  assert.deepEqual(
    argument("echo [[:alpha:]").parts?.map((part) => [part.type, part.text]),
    [
      ["Literal", "["],
      ["Glob", "[:alpha:]"],
    ],
  );
});

test("bracket boundaries follow Bash's class, symbol and range scanning", () => {
  // Bash 5.3.20: `[:` and `[=` close at the first `:]` or `=]` unless a raw `]` comes first,
  // `[.` closes at the first `.]` even past a `]`, a class never starts a range, and a range end
  // consumes one member, be it an escape, `[` or a collating symbol.
  for (const [spelling, ...expected] of [
    ["[[:alpha:]-[:digit:]]", ["Glob", "[[:alpha:]-[:digit:]]"]],
    ["[[=a=]-[:digit:]]", ["Glob", "[[=a=]-[:digit:]]"]],
    ["[a-bc-[:alpha:]]", ["Glob", "[a-bc-[:alpha:]"], ["Literal", "]"]],
    ["[a-bc--[:x:]]", ["Glob", "[a-bc--[:x:]]"]],
    ["[[.b.]-xyz-[=a=]", ["Glob", "[[.b.]-xyz-[=a=]"]],
    [String.raw`[a-\[.z.]]`, ["Glob", String.raw`[a-\[.z.]]`]],
    [String.raw`[[[-\[.a.]`, ["Literal", "[["], ["Glob", String.raw`[-\[.a.]`]],
    [String.raw`[b-\[.a.][=a=`],
    ["[[:a]:]]", ["Glob", "[[:a]"], ["Literal", ":]]"]],
    ["[[:al]pha:]]", ["Glob", "[[:al]"], ["Literal", "pha:]]"]],
    ["[[=a]b=]]", ["Glob", "[[=a]"], ["Literal", "b=]]"]],
    ["[[=]=]]", ["Glob", "[[=]"], ["Literal", "=]]"]],
    ["[[:]]", ["Glob", "[[:]"], ["Literal", "]"]],
    ["[[.].]]", ["Glob", "[[.].]]"]],
    ["[[.a]b.]c]", ["Glob", "[[.a]b.]c]"]],
    ["[[:foo:]x]", ["Glob", "[[:foo:]x]"]],
    ["[[::]]", ["Glob", "[[::]]"]],
    ["[[:digit:]-z]", ["Glob", "[[:digit:]-z]"]],
    ["[[.a.]-z]", ["Glob", "[[.a.]-z]"]],
    ["[a-[.z.]]", ["Glob", "[a-[.z.]]"]],
    ["[a-[:alpha:]]", ["Glob", "[a-[:alpha:]"], ["Literal", "]"]],
    ["[a-[=b=]c]", ["Glob", "[a-[=b=]"], ["Literal", "c]"]],
    ["[!a-[=a=]z.]", ["Glob", "[!a-[=a=]"], ["Literal", "z.]"]],
    [String.raw`[a-\]]`, ["Glob", String.raw`[a-\]]`]],
    [String.raw`[[:\]!=:]]a`, ["Glob", String.raw`[[:\]!=:]`], ["Literal", "]a"]],
    [String.raw`[\[[=[]=]`, ["Glob", String.raw`[\[[=[]`], ["Literal", "=]"]],
    ["[]-a]", ["Glob", "[]-a]"]],
    ["[--/]", ["Glob", "[--/]"]],
    ["[a-]", ["Glob", "[a-]"]],
    ["[x[:alpha:]", ["Literal", "[x"], ["Glob", "[:alpha:]"]],
  ] as const) {
    const parts = argument(`echo ${spelling}`).parts?.map((part) => [part.type, part.text]);
    assert.deepEqual(parts, expected.length > 0 ? expected : undefined, spelling);
  }
});

test("bracket expressions retain quoted and expanded interior structure", () => {
  const word = argument('echo ["a"$x]');
  const glob = nodeOfType(word.parts?.[0], "Glob");
  assert.equal(glob.text, '["a"$x]');
  assert.equal(glob.kind, "bracket");
  assert.equal(glob.value, "[a$x]");
  assert.deepEqual(
    glob.parts?.map((part) => [part.type, part.pos, part.end, part.text]),
    [
      ["DoubleQuoted", 6, 9, '"a"'],
      ["SimpleExpansion", 9, 11, "$x"],
    ],
  );
  assert.equal(word.value, "[a$x]");
});

test("bracket markers describe source syntax without evaluating quoted members", () => {
  const word = argument('echo [""]');
  const glob = nodeOfType(word.parts?.[0], "Glob");
  assert.equal(glob.text, '[""]');
  assert.equal(glob.value, "[]");
  assert.equal(glob.parts?.[0].type, "DoubleQuoted");
  assert.equal(word.value, "[]");
});

test("wildcards and delimiters within bracket members keep their existing meaning", () => {
  const glob = nodeOfType(argument('echo [a"[x]"*?]').parts?.[0], "Glob");
  assert.deepEqual(
    glob.parts?.map((part) => [part.type, part.text]),
    [
      ["Literal", "a"],
      ["DoubleQuoted", '"[x]"'],
      ["Literal", "*?"],
    ],
  );
  const expansion = nodeOfType(argument('echo [a${x:-"]"}b]').parts?.[0], "Glob");
  assert.equal(expansion.text, '[a${x:-"]"}b]');
  assert.equal(expansion.parts?.[1].type, "ParameterExpansion");
});

test("substitution scripts inside brackets remain traversable", () => {
  const glob = nodeOfType(argument("echo [a$(printf b)c]").parts?.[0], "Glob");
  assert.deepEqual(
    glob.parts?.map((part) => part.type),
    ["Literal", "CommandExpansion", "Literal"],
  );
  const expansion = nodeOfType(glob.parts?.[1], "CommandExpansion");
  assert.equal(nodeOfType(expansion.script?.commands[0].command, "Command").name?.value, "printf");
});

test("globs preserve separate brace and extended glob nodes", () => {
  assert.deepEqual(
    argument("echo *.{js,ts}").parts?.map((part) => [part.type, part.text]),
    [
      ["Glob", "*"],
      ["Literal", "."],
      ["BraceExpansion", "{js,ts}"],
    ],
  );
  assert.deepEqual(
    argument("echo ?(foo|bar)*").parts?.map((part) => [part.type, part.text]),
    [
      ["ExtendedGlob", "?(foo|bar)"],
      ["Glob", "*"],
    ],
  );
  assert.deepEqual(
    argument("echo **(foo)").parts?.map((part) => [part.type, part.text]),
    [
      ["Glob", "*"],
      ["ExtendedGlob", "*(foo)"],
    ],
  );
});

test("extglob operators in parameter operands retain their existing structure and values", () => {
  const expansion = nodeOfType(argument('echo ${v#@("x"|a*)}').parts?.[0], "ParameterExpansion");
  assert.equal(expansion.operation?.type, "Remove");
  if (expansion.operation?.type !== "Remove") return;
  const operand = expansion.operation.operand;
  assert.equal(operand.value, "@(x|a*)");
  assert.deepEqual(
    operand.parts?.map((part) => [part.type, part.text]),
    [
      ["Literal", "@("],
      ["DoubleQuoted", '"x"'],
      ["Literal", "|a"],
      ["Glob", "*"],
      ["Literal", ")"],
    ],
  );
  assert.equal(operand.value, "@(x|a*)");

  const nested = nodeOfType(argument("echo @(a|*(b?))").parts?.[0], "ExtendedGlob");
  assert.deepEqual(
    nested.parts?.map((part) => [part.type, part.text]),
    [
      ["Literal", "a|*(b"],
      ["Glob", "?"],
      ["Literal", ")"],
    ],
  );
});

test("continued extglob operators do not absorb preceding plain wildcards", () => {
  for (const [source, value, expected] of [
    [
      "echo ${v#*\\\n(a?)}",
      "*(a?)",
      [
        ["Literal", "*\\\n(a"],
        ["Glob", "?"],
        ["Literal", ")"],
      ],
    ],
    [
      "echo ${v#**(a)}",
      "**(a)",
      [
        ["Glob", "*"],
        ["Literal", "*(a)"],
      ],
    ],
    [
      "echo ${v#***\\\n(a)}",
      "***(a)",
      [
        ["Glob", "**"],
        ["Literal", "*\\\n(a)"],
      ],
    ],
    [
      "echo ${v#?\\\n(a*)}",
      "?(a*)",
      [
        ["Literal", "?\\\n(a"],
        ["Glob", "*"],
        ["Literal", ")"],
      ],
    ],
  ] as const) {
    const expansion = nodeOfType(argument(source).parts?.[0], "ParameterExpansion");
    assert.equal(expansion.operation?.type, "Remove");
    if (expansion.operation?.type !== "Remove") continue;
    const operand = expansion.operation.operand;
    assert.equal(operand.value, value);
    assert.deepEqual(
      operand.parts?.map((part) => [part.type, part.text]),
      expected,
    );
    assert.equal(operand.value, value);
  }
});

test("quoted and escaped parentheses do not turn plain wildcards into operators", () => {
  for (const source of ['echo ${v#*"("a}', "echo ${v#*\\(a}"]) {
    const expansion = nodeOfType(argument(source).parts?.[0], "ParameterExpansion");
    assert.equal(expansion.operation?.type, "Remove");
    if (expansion.operation?.type !== "Remove") continue;
    const operand = expansion.operation.operand;
    assert.equal(operand.value, "*(a");
    assert.equal(operand.parts?.[0].type, "Glob");
    assert.equal(operand.parts?.[0].text, "*");
    assert.equal(operand.value, "*(a");
  }
});

test("glob source ranges and printing remain exact inside nested scripts", () => {
  const source = 'echo $(printf "prefix"[a-z]*.txt)';
  const ast = parse(source);
  const expansion = nodeOfType(argument(source).parts?.[0], "CommandExpansion");
  const word = nodeOfType(nodeOfType(expansion.script?.commands[0].command, "Command").suffix[0], "Word");
  for (const part of word.parts ?? []) assert.equal(source.slice(part.pos, part.end), part.text);
  assert.deepEqual(
    word.parts?.map((part) => part.type),
    ["DoubleQuoted", "Glob", "Glob", "Literal"],
  );
  assert.equal(word.value, "prefix[a-z]*.txt");
  assert.equal(print(ast), source);
});

test("unmatched bracket scanning grows linearly", () => {
  function characterReads(count: number): number {
    const charCodeAt = String.prototype.charCodeAt;
    let reads = 0;
    String.prototype.charCodeAt = function (index: number): number {
      reads++;
      return charCodeAt.call(this, index);
    };
    try {
      const word = argument("echo " + "[[:".repeat(count) + "x?");
      assert.equal(word.parts?.length, 2);
      assert.equal(word.parts?.[1].type, "Glob");
    } finally {
      String.prototype.charCodeAt = charCodeAt;
    }
    return reads;
  }
  assert.ok(characterReads(4096) < characterReads(2048) * 2.1);
});

test("matched bracket resolution grows linearly", () => {
  function characterReads(pattern: string, expectedParts: number): number {
    const charCodeAt = String.prototype.charCodeAt;
    let reads = 0;
    String.prototype.charCodeAt = function (index: number): number {
      reads++;
      return charCodeAt.call(this, index);
    };
    try {
      const word = argument("echo " + pattern);
      assert.equal(word.parts?.length, expectedParts);
      assert.equal(word.parts?.at(-1)?.type, "Glob");
    } finally {
      String.prototype.charCodeAt = charCodeAt;
    }
    return reads;
  }
  const classes = (count: number) => characterReads("[[:a:]".repeat(count), 2 * count);
  const openers = (count: number) => characterReads("[[[:a:]".repeat(count), 2 * count);
  const members = (count: number) => characterReads("[a".repeat(count) + "]", 1);
  assert.ok(classes(4096) < classes(2048) * 2.1);
  assert.ok(openers(4096) < openers(2048) * 2.1);
  assert.ok(members(4096) < members(2048) * 2.1);
});

function elements(source: string) {
  const ast = parse(source);
  assert.equal(ast.errors, undefined, source);
  const command = nodeOfType(ast.commands[0].command, "Command");
  const words = arrayElements(nodeOfType(command.prefix[0], "Assignment"));
  assert.ok(words, source);
  return words;
}

test("a leading bracket expression in an array element is a glob unless it keys the element", () => {
  // Bash reads `[...]` at the start of an element as a matched pair, but only `[key]=` and
  // `[key]+=` select an element; any other element is a value that undergoes pathname expansion.
  const [files] = elements("files=([^_]*.txt)");
  assert.deepEqual(files.parts, [
    {
      type: "Glob",
      kind: "bracket",
      pos: 7,
      end: 11,
      text: "[^_]",
      value: "[^_]",
      parts: [{ type: "Literal", pos: 8, end: 10, text: "^_", value: "^_" }],
    },
    { type: "Glob", kind: "star", pos: 11, end: 12, text: "*", value: "*", parts: undefined },
    { type: "Literal", pos: 12, end: 16, text: ".txt", value: ".txt" },
  ]);
  assert.equal(print(parse("files=([^_]*.txt)")), "files=([^_]*.txt)");

  const [spaced, keyed] = elements("a=([x y]z [0]=q)");
  assert.equal(spaced.text, "[x y]z");
  assert.equal(spaced.value, "[x y]z");
  assert.deepEqual(spaced.parts, [
    {
      type: "Glob",
      kind: "bracket",
      pos: 3,
      end: 8,
      text: "[x y]",
      value: "[x y]",
      parts: [{ type: "Literal", pos: 4, end: 7, text: "x y", value: "x y" }],
    },
    { type: "Literal", pos: 8, end: 9, text: "z", value: "z" },
  ]);
  assert.equal(keyed.parts, undefined);

  const [whole, unkeyed, empty] = elements("a=([ab] [a]b=c []x)");
  assert.deepEqual(
    whole.parts?.map((part) => [part.type, part.text]),
    [["Glob", "[ab]"]],
  );
  assert.deepEqual(
    unkeyed.parts?.map((part) => [part.type, part.text]),
    [
      ["Glob", "[a]"],
      ["Literal", "b=c"],
    ],
  );
  assert.equal(empty.parts, undefined);
});

test("keyed array elements keep their subscript as literal text", () => {
  const [plain, expanded, appended, bare, doubled] = elements("a=([x y]=1 [$i]+=2 [a]+=b [a]= [x]==y)");
  assert.equal(plain.parts, undefined);
  assert.deepEqual(
    expanded.parts?.filter((part) => part.type !== "Literal").map((part) => [part.type, part.text]),
    [["SimpleExpansion", "$i"]],
  );
  assert.equal(appended.parts, undefined);
  assert.equal(bare.parts, undefined);
  assert.equal(doubled.parts, undefined);
  // A line continuation between `]` and the operator still keys the element.
  assert.equal(
    elements("a=([x]\\\n=1 [y]\\\n+=2)").every((word) => word.parts === undefined),
    true,
  );
});

test("leading bracket globs in array elements follow the matcher's extent rules", () => {
  const texts = (source: string) =>
    elements(source).map((word) =>
      word.parts?.map((part) => [part.type, part.pos, part.end, part.text, "value" in part ? part.value : undefined]),
    );
  assert.deepEqual(texts("a=([[:alpha:]]x)"), [
    [
      ["Glob", 3, 14, "[[:alpha:]]", "[[:alpha:]]"],
      ["Literal", 14, 15, "x", "x"],
    ],
  ]);
  assert.deepEqual(texts(String.raw`a=([a\]b]c)`), [
    [
      ["Glob", 3, 9, String.raw`[a\]b]`, "[a]b]"],
      ["Literal", 9, 10, "c", "c"],
    ],
  ]);
  assert.deepEqual(texts("a=([!]]x []]x [x]+y)"), [
    [
      ["Glob", 3, 7, "[!]]", "[!]]"],
      ["Literal", 7, 8, "x", "x"],
    ],
    [
      ["Glob", 9, 12, "[]]", "[]]"],
      ["Literal", 12, 13, "x", "x"],
    ],
    [
      ["Glob", 14, 17, "[x]", "[x]"],
      ["Literal", 17, 19, "+y", "+y"],
    ],
  ]);
  assert.deepEqual(texts("x[1]=([a]b)"), [
    [
      ["Glob", 6, 9, "[a]", "[a]"],
      ["Literal", 9, 10, "b", "b"],
    ],
  ]);
  // The tokenizer's matched pair ends at the first `]`; the pattern extent does not.
  for (const element of [
    "[!]a[b]]",
    "[][b]]",
    "[][q]",
    "[!][q]",
    "[][[:alpha:]]]z",
    "[]@[b]]",
    "[][:digit:]]=v",
    "[a$x]b",
  ]) {
    const [word] = elements(`a=(${element})`);
    const argument = nodeOfType(nodeOfType(parse(`echo ${element}`).commands[0].command, "Command").suffix[0], "Word");
    const shape = (parts: readonly WordPart[] | undefined, offset: number) =>
      parts?.map((part) => [part.type, part.pos - offset, part.end - offset, part.text]);
    assert.deepEqual(shape(word.parts, 3), shape(argument.parts, 5), element);
  }
  assert.deepEqual(texts("a=([!]a[b]] [][q])"), [
    [
      ["Glob", 3, 10, "[!]a[b]", "[!]a[b]"],
      ["Literal", 10, 11, "]", "]"],
    ],
    [["Glob", 12, 17, "[][q]", "[][q]"]],
  ]);
});

test("quoted and expanded members of a leading bracket glob stay its children", () => {
  const [word] = elements('a=(["$x"]y)');
  const bracket = word.parts?.[0];
  assert.equal(bracket?.type, "Glob");
  if (bracket?.type !== "Glob") return;
  assert.deepEqual(
    [bracket.kind, bracket.pos, bracket.end, bracket.text, bracket.value],
    ["bracket", 3, 9, '["$x"]', "[$x]"],
  );
  assert.deepEqual(
    bracket.parts?.map((part) => [part.type, part.text]),
    [["DoubleQuoted", '"$x"']],
  );
  assert.deepEqual(
    word.parts?.slice(1).map((part) => [part.type, part.text]),
    [["Literal", "y"]],
  );
});
