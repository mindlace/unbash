import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ParsedScript, SyntaxNode } from "../src/types.ts";

export type Mode = "parse" | "value" | "parts" | "json";
export type ParserSpec = {
  name: string;
  kind:
    | "unbash"
    | "tree-sitter-bash-native"
    | "tree-sitter-bash-wasm"
    | "sh-syntax"
    | "bash-parser"
    | "eric-bash-parser";
  entry?: string;
};
export type Adapter = {
  parse: (source: string) => number | Promise<number>;
  asynchronous: boolean;
  dispose?: () => void;
};

const require = createRequire(import.meta.url);
export async function loadParser(spec: ParserSpec, mode: Mode): Promise<Adapter> {
  if (spec.kind === "unbash") {
    if (!spec.entry) throw new Error("Unbash requires a parser entry path");
    const entry = resolve(spec.entry);
    const { parse }: { parse: (source: string) => ParsedScript } = await import(pathToFileURL(entry).href);
    if (mode === "parse") {
      return {
        parse: (source) => {
          const ast = parse(source);
          return ast.commands.length + (ast.errors?.length ?? 0);
        },
        asynchronous: false,
      };
    }
    if (mode === "json") return { parse: (source) => JSON.stringify(parse(source)).length, asynchronous: false };
    const traversal = join(dirname(entry), `traversal${extname(entry)}`);
    const { forEachChild }: { forEachChild: (node: SyntaxNode, visit: (child: SyntaxNode) => void) => void } =
      await import(pathToFileURL(traversal).href);
    return {
      parse: (source) => {
        let count = 0;
        function visit(node: SyntaxNode): void {
          count++;
          if (mode === "value" && node.type === "Word") {
            count += node.value.length;
            return;
          }
          if (mode === "value" && node.type === "HereDocBody") return;
          forEachChild(node, visit);
        }
        visit(parse(source));
        return count;
      },
      asynchronous: false,
    };
  }

  if (mode !== "parse") throw new Error(`${spec.name} only supports parse mode`);
  if (spec.kind === "tree-sitter-bash-native") {
    const { default: Parser } = await import("tree-sitter");
    const { default: Bash } = await import("tree-sitter-bash");
    const parser = new Parser();
    parser.setLanguage(Bash);
    return {
      parse: (source) => parser.parse(source).rootNode.namedChildCount,
      asynchronous: false,
    };
  }
  if (spec.kind === "tree-sitter-bash-wasm") {
    const { Parser, Language } = await import("web-tree-sitter");
    await Parser.init();
    const language = await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
    const parser = new Parser();
    parser.setLanguage(language);
    return {
      parse: (source) => {
        const tree = parser.parse(source);
        if (!tree) throw new Error("Parser returned no tree");
        const count = tree.rootNode.namedChildCount;
        tree.delete();
        return count;
      },
      asynchronous: false,
      dispose: () => parser.delete(),
    };
  }
  if (spec.kind === "sh-syntax") {
    const { parse } = await import("sh-syntax");
    await parse("echo hello");
    return {
      parse: async (source) => (await parse(source)).Stmts.length,
      asynchronous: true,
    };
  }
  const name = spec.kind === "bash-parser" ? "bash-parser" : "@ericcornelissen/bash-parser";
  const { default: parse }: { default: (source: string) => { commands: unknown[] } } = await import(name);
  return {
    parse: (source) => parse(source).commands.length,
    asynchronous: false,
  };
}
