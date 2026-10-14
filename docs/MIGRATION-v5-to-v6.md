# Migrating from v5

v6 adds `Glob` word parts and `forEachChild`, stores elif branches, pipeline
prefixes, test negations and logical test operands in arrays, and resolves
embedded scripts and arithmetic expressions on access. `parse` and `print` keep
their signatures.

A visitor can compile unchanged while missing bracket substitutions and elif
branches; `forEachChild` enumerates both.

## Glob parts

Unquoted `*`, `?` and bracket expressions are `Glob` parts with source text and
positions. Consecutive stars form one part, so `**` stays identifiable; each `?`
is its own part.

```ts
type GlobPart = StarGlobPart | QuestionGlobPart | BracketGlobPart;

interface BracketGlobPart {
  readonly type: "Glob";
  readonly kind: "bracket";
  readonly pos: number;
  readonly end: number;
  readonly text: string;
  readonly value: string;
  readonly parts: readonly WordPart[];
}
```

Star and question parts have the same fields with `kind: "star"` or `"question"`
and no `parts`. A bracket owns its interior: `[ab]` contains `Literal("ab")` and
`["a"$x]` contains `DoubleQuoted` and `SimpleExpansion`. Boundaries follow
Bash's matcher: `[:class:]` and `[=c=]` close at their own terminator unless a
`]` comes first, `[.sym.]` closes only at `.]`, and a range end consumes one
member. `value` removes quotes and escapes like `Word.value` and can still
contain expansion text.

Words such as `foo*` had no parts and now have `Literal("foo")` and `Glob("*")`;
`*.{js,ts}` is `Glob("*")`, `Literal(".")` and `BraceExpansion("{js,ts}")`.
Quoted and escaped wildcards stay literal. Brace and extglob bodies can contain
`Glob` parts.

Substitutions inside brackets move below the new parent:

```text
pnpm --filter=[$(git rev-parse HEAD~1)] exec pnpm pack

v5: Literal("--filter=["), CommandExpansion, Literal("]")
v6: Literal("--filter="), Glob(kind: "bracket", parts: [CommandExpansion])
```

A scan of top-level parts now misses `git`. Recurse into bracket parts,
including quoted children such as `["$(cmd)"]`, or use `forEachChild`.

## Source syntax and evaluation

`Glob` and `BraceExpansion` parts mark syntax; the parent node decides whether
Bash expands them. `x=*` and `x={a,b}` keep their markers although neither
expands; `declare x={a,b}` is brace-expanded as an argument of a declaration
command. A scalar value and a keyed `[k]=v` element never undergo filename
expansion, but unkeyed elements of a compound array value do:
`files=([^_]*.txt)` carries a bracket `Glob` while `a=([0]=*.txt)` keeps its key
literal. In `command export x=*` the word is an ordinary argument and undergoes
both. Arithmetic, array indexes, regexes and heredoc text carry no markers.
Variables and substitutions can produce pattern characters at runtime and
`set -f` does not remove markers, so a marker is not a filesystem prediction.

## Lazy access

`parts` builds glob parts on first read. Command and process substitutions
resolve `script` on access and arithmetic expansions resolve `expression`, so
reading `value` or `parts` never parses an embedded script. Nested parse errors
stay on the nested script.

Lazy fields are prototype getters: `JSON.stringify` resolves them (note that
`Object.keys`, spread and `structuredClone` drop them!). A backtick script whose
body contains backslash escapes parses its decoded body and carries it as
`source`.

## Traversal

`forEachChild(node, callback)` visits the direct canonical children of live and
JSON-restored nodes, lazy fields included, and does not recurse. The callback
receives only the child, its return value is ignored, errors propagate, and
children keep their identity across calls. A Command's `prefix`, `name` and
`suffix` are visited once; the derived `args` and `redirects` views are not.
Recursive callers own their stack limits and check each nested script's
`errors`.

## Elif branches

v5 nested each elif branch as an `If` in the previous branch's `else`, every
branch ending at `fi`. In v6 the first branch stays in `If.clause` and
`If.then`, further branches are siblings in `If.elif`, empty when absent, and
`If.else` holds only the `else` body. A visitor that recurses into `If.else`
still type-checks but skips every elif branch; iterate `elif` or use
`forEachChild`.

```ts
interface If {
  readonly type: "If";
  readonly pos: number;
  readonly end: number;
  readonly clause: CompoundList;
  readonly then: CompoundList;
  readonly elif: readonly Elif[]; // new
  readonly else: CompoundList | undefined; // v5: CompoundList | If | undefined
}

interface Elif {
  readonly type: "Elif";
  readonly pos: number;
  readonly end: number;
  readonly clause: CompoundList;
  readonly then: CompoundList;
}
```

An `Elif` covers its keyword, condition and body and ends before the next branch
or `fi`; the `If` covers the whole construct. An `if` inside an `else` body is
still a nested command with its own `fi`.

## Pipeline prefixes

v5 wrapped a pipeline in one nested `Time` or `Negation` node per prefix, each
spanning the rest of the pipeline. In v6 they are records in
`Pipeline.prefixes`, each covering only its keyword and, for `time`, its `-p`
and `--` options; `Negation` loses `keywordEnd`, which equaled `end`. A prefixed
command or a bare prefix is a `Pipeline` with one or no commands; an unprefixed
single command is still not wrapped. `! time -p cmd | x` is one `Pipeline` with
`Negation` and `Time` prefixes and two commands.

```ts
type PipelineNode = CommandNode | Pipeline; // v5: also Time | Negation

interface Pipeline {
  readonly type: "Pipeline";
  readonly pos: number;
  readonly end: number;
  readonly prefixes: readonly PipelinePrefix[]; // new
  readonly commands: readonly CommandNode[];
  readonly operators: readonly PipeOperator[];
}

type PipelinePrefix = Time | Negation; // v5: both had a command
```

## Test expressions

`TestLogical.left` and `right` become `operands` in source order, so `[[ a && b
&& c ]]` has one `TestLogical` with three operands. Precedence stays structural:
`a && b || c && d` is an OR node with two AND operands, and parentheses keep
`TestGroup`. One `TestNot` holds a `Negation` per `!`, so `[[ ! ! x ]]` has one
`TestNot` with two negations; an odd count negates. Arithmetic expressions keep
their shapes.

## Nesting limits

Input nested past 256 levels yields a partial tree with a source-positioned
error for each limit found while scanning: over-deep compound bodies are skipped
and parsing resumes after their closing delimiter, and truncated word and
arithmetic subtrees keep their source text. Compound commands and test groups
share one counter per script, nested scripts inherit word and substitution
depth, and arithmetic counts recursive parsing; elif branches, pipeline
prefixes, test negations and logical test operands add no levels.

Command substitution, parameter expansion, arithmetic expansion and arithmetic
parenthesis chains past the limit are reported while parsing, so `errors` is
complete when `parse` returns.

Depth reached through lazy fields recovers silently with source text: arithmetic
operator chains with or without parentheses, parentheses in `for ((;;))` headers
and `$[ ]`, parameter expansions inside arithmetic, and expansions inside array
elements, heredoc bodies, brace or extglob bodies and `${...}` sub-fields.
Embedded scripts keep their own diagnostics. The limit bounds neither tree
height nor output size, so JSON serialization and recursive consumers can still
hit their own limits.
