import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.ts";
import { nodeOfType } from "./ast-helpers.ts";

test("over-deep expansion scans preserve the complete word and following command", () => {
  for (const [open, close] of [
    ["${x:-", "}"],
    ["$(echo ", ")"],
    ["$((", "))"],
  ]) {
    const word = open.repeat(2000) + "x" + close.repeat(2000);
    const ast = parse("echo " + word + "; after 'kept value'");
    assert.ok(ast.errors?.some((error) => error.message.includes("nesting depth")));
    const command = nodeOfType(ast.commands[0].command, "Command");
    assert.equal(nodeOfType(command.suffix[0], "Word").text, word);
    assert.equal(nodeOfType(command.suffix[0], "Word").value, word);
    const after = nodeOfType(ast.commands[1].command, "Command");
    assert.equal(after.name?.value, "after");
    assert.equal(nodeOfType(after.suffix[0], "Word").value, "kept value");
  }
});

test("over-deep quoted scans recover without exhausting the JavaScript stack", () => {
  for (const [open, close] of [
    ['"${x:-', '}"'],
    ['"$(echo ', ')"'],
    ['"${x:-$(echo ', ')}"'],
  ]) {
    const word = open.repeat(2000) + "x" + close.repeat(2000);
    const ast = parse("echo " + word + "; after 'kept value'");
    assert.ok(ast.errors?.some((error) => error.message.includes("nesting depth")));
    const command = nodeOfType(ast.commands[0].command, "Command");
    assert.equal(nodeOfType(command.suffix[0], "Word").text, word);
    assert.equal(nodeOfType(command.suffix[0], "Word").value, word.slice(1, -1));
    const after = nodeOfType(ast.commands[1].command, "Command");
    assert.equal(after.name?.value, "after");
    assert.equal(nodeOfType(after.suffix[0], "Word").value, "kept value");
  }
});

test("quote recovery preserves command substitution case and heredoc boundaries", () => {
  for (const body of ["$(case x in x) echo ')' ;; esac)", '$(cat <<EOF\n)"}\nEOF\n)']) {
    const word = '"${x:-'.repeat(300) + body + '}"'.repeat(300);
    const ast = parse("echo " + word + "; after");
    assert.ok(ast.errors?.some((error) => error.message.includes("nesting depth")));
    assert.equal(nodeOfType(nodeOfType(ast.commands[0].command, "Command").suffix[0], "Word").text, word);
    assert.equal(nodeOfType(ast.commands[1].command, "Command").name?.value, "after");
  }
});

test("sibling arithmetic and quoted substitutions do not exhaust the scan budget", () => {
  for (const word of [
    "$(echo " + "$((1)) ".repeat(300) + ")",
    "$((" + "$((1))+".repeat(300) + "1))",
    "$(echo " + '"$(echo x)" '.repeat(300) + ")",
  ]) {
    const ast = parse("echo " + word + "; after");
    assert.equal(ast.errors, undefined);
    assert.equal(nodeOfType(ast.commands[1].command, "Command").name?.value, "after");
  }
});
