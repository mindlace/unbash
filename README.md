# unbash

Fast 0-deps bash parser written in TypeScript

[![NPM Version][2]][1] [![NPM Downloads][3]][1]

## Install

```sh
npm install unbash
```

## When to use unbash?

Use unbash when your input is Bash source: a pasted command, a complete script,
or shell source embedded in another format, and you need to inspect its
structure without executing it. It returns a typed, source-positioned AST.

Example use cases:

- Classify scripts for permission prompts, allowlists, or audit findings
- Collect executables and literal file, configuration, and dependency references
- Import or convert commands such as `curl` to code
- Build a shell portability checker using parse errors and AST analysis
- Attach diagnostics to generated or pasted Bash using source-positioned errors
  and partial trees
- Build explanations, visualizations, or structured previews of pipelines,
  conditions, expansions, and nested commands

## Supported syntax

unbash parses GNU Bash.

Currently at Bash v5.3 with non-interactive defaults including `extglob`
patterns. Supported syntax includes commands, control flows, pipelines,
redirects, assignments, compound statements, parameter and word expansions,
process and nested substitutions, coproc, heredocs, herestrings, nested and
generated syntax, etc. etc.

POSIX `sh` scripts parse as Bash. unbash does not gate syntax by version, i.e.
it accepts syntax that older Bash releases reject.

## Unsupported syntax

Other shell languages are not supported: zsh, ksh93, mksh, fish, PowerShell,
`cmd.exe`, csh, Bats test files. Such scripts may produce errors or a misleading
tree.

unbash is a tolerant parser: for malformed, incomplete or excessively nested
input, it recovers where possible and returns a best-effort partial AST with
source-positioned errors for what it detects while parsing.

To parse `process.argv` (`string[]`), use Node.js [`parseArgs`][4] or a library
such as [yargs][5] or [citty][6].

## Usage

```ts
import { parse } from "unbash";

const ast = parse('if [ -f "$1" ]; then cat "$1"; fi');
```

Result:

```js
{
  type: "Script",
  commands: [{
    type: "Statement",
    command: {
      type: "If",
      clause: { type: "CompoundList", commands: [ /* [ -f "$1" ] */ ] },
      then: { type: "CompoundList", commands: [ /* cat "$1" */ ] }
    }
  }]
}
```

See the full AST at [unbash.statichost.page#input=if \[ -f...][7]

Positions are zero-based UTF-16 code-unit offsets forming half-open `[pos, end)`
ranges into the source.

### Visit

`forEachChild(node, callback)` calls the callback once for each direct child,
including word parts such as expansions and the `script` of a substitution,
which resolve on first access. It does not recurse: call it from the callback to
descend, or skip the call to leave a subtree unresolved.

```ts
import { forEachChild, parse, type SyntaxNode } from "unbash";

const source = 'echo "$HOME" $(mktemp -d)';

function visit(node: SyntaxNode): void {
  if (node.type === "Command") console.log(source.slice(node.pos, node.end));
  forEachChild(node, visit);
}

visit(parse(source));
// echo "$HOME" $(mktemp -d)
// mktemp -d
```

The callback receives only the child and its return value is ignored. A nested
script reports its own `errors`, so check them while visiting. See [Migrating
from v5][8] for the node shapes and lazy fields.

### Print

Basic opinionated printer, does not preserve whitespace or comments (except
shebang):

```ts
import { parse } from "unbash";
import { print } from "unbash/printer";

const ast = parse('if [ -f "$1" ]; then cat "$1"; fi');
const script = print(ast);
```

Result:

```sh
if [ -f "$1" ]; then
  cat "$1"
fi
```

## unbash vs tree-sitter-bash

[tree-sitter-bash][9] is the right choice when you need:

- Incremental parsing
- CST output preserving all tokens and punctuation
- Error recovery with `ERROR` nodes and missing tokens

unbash provides:

- A typed, executable-syntax AST instead of a grammar CST
- A synchronous, zero-dependency TypeScript package with no native addon, WASM
  runtime, parser initialization, or query layer
- Structured word parts, arithmetic and test-expression trees, recursively
  parsed substitutions, and direct source positions
- Best-effort error recovery that preserves a partial AST and collects errors
- Also see [tree-sitter-bash gaps covered by unbash][10]

## unbash vs sh-syntax

[sh-syntax][11] is a WASM wrapper around the robust [mvdan/sh][12] Go parser. It
is highly recommended if you need:

- Support for Bash, POSIX sh, mksh, Bats, and experimental Zsh parsing
- Mature, configurable formatting and pretty-printing

unbash provides:

- A zero-dependency, synchronous TypeScript API without WASM loading
- A smaller, JSON-friendly Bash AST with lazy structured word parts, recursively
  parsed substitutions, and direct source positions
- Best-effort partial ASTs for malformed or incomplete editor and user input
- Also see [sh-syntax gaps covered by unbash][13]

## unbash vs bash-parser

[bash-parser][14] and its fork [@ericcornelissen/bash-parser][15] (community
dependency maintenance fork ❤️ now archived) provide:

- A POSIX-only mode that rejects bash-specific syntax

unbash provides:

- A zero-dependency architecture
- A typed TypeScript API (ESM-only)
- Best-effort error recovery that preserves a partial AST and collects errors
- Structured AST nodes for parameter expansions, arithmetic expressions, and `[[
  ]]` test expressions; `bash-parser` treats `[[ ]]` as ordinary commands and
  `(( ))` as nested subshells
- Herestrings, C-style `for`, `select`, process substitution, `coproc`, array
  assignments, extglob, `;&`/`;;&` case fallthrough, Bash 5.3 command
  substitutions, and `{variable}` file-descriptor redirects

## Benchmarks

Parse throughput in MB/s; higher is better. Median per-run p75 iteration times
from 11 runs per unbash version and 22 per other parser, on Apple M1 Pro/32GB
with Node.js 24.19.0. Parentheses show speed relative to unbash v5.

| Parser                       | short (1.1KiB) | advanced (0.9KiB) | medium (150KiB) | large (970KiB) |
| ---------------------------- | -------------: | ----------------: | --------------: | -------------: |
| **unbash v5**                |       **77.3** |          **70.3** |       **101.5** |      **117.6** |
| unbash v4                    |   79.2 (0.98x) |      71.3 (0.99x) |    97.9 (1.04x) |  116.0 (1.01x) |
| tree-sitter-bash (native)    |     4.59 (17x) |        6.51 (11x) |      15.08 (7x) |    11.90 (10x) |
| tree-sitter-bash (WASM)      |     5.02 (15x) |        5.61 (13x) |      8.85 (11x) |     8.27 (14x) |
| sh-syntax                    |   0.03 (2290x) |      0.04 (1659x) |      8.28 (12x) |     14.06 (8x) |
| bash-parser                  |    0.27 (290x) |               n/a |             n/a |            n/a |
| @ericcornelissen/bash-parser |    0.26 (301x) |               n/a |             n/a |            n/a |

Run the benchmarks using Node.js 24+:

```sh
pnpm install
pnpm bench
```

## Size

The parser bundle is 85K minified and 21K gzipped.

## Playgrounds

- [unbash.statichost.page][16]
- [ast-explorer.dev][17]

## License

ISC

[1]: https://www.npmx.dev/package/unbash
[2]: https://img.shields.io/npm/v/unbash?color=f56e0f
[3]: https://img.shields.io/npm/dm/unbash?color=f56e0f
[4]: https://nodejs.org/api/util.html#utilparseargsconfig
[5]: https://yargs.js.org/
[6]: https://www.npmjs.com/package/citty
[7]: https://unbash.statichost.page/#input=if%20%5B%20-f%20%22%241%22%20%5D%3B%20then%20cat%20%22%241%22%3B%20fi
[8]: docs/MIGRATION-v5-to-v6.md
[9]: https://github.com/tree-sitter/tree-sitter-bash
[10]: https://github.com/webpro-nl/unbash/issues/6
[11]: https://github.com/un-ts/sh-syntax
[12]: https://github.com/mvdan/sh
[13]: https://github.com/webpro-nl/unbash/issues/7
[14]: https://github.com/vorpaljs/bash-parser
[15]: https://github.com/ericcornelissen/bash-parser
[16]: https://unbash.statichost.page
[17]: https://ast-explorer.dev/#eNoVjDsKwzAQRK8yDK5CyAGS2nVAId02jixZAbFr/Kls393rbh7zeBsrn5xLqpV3jr5X/XVzcYgOKRaD8LoNzffTBqFotgkZf8XtUW14oTdRIHaLq00WYscwpRFtCO8g2psm75n3toPHCdz+Ivg=
