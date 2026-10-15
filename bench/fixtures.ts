import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fixturesDir = join(import.meta.dirname, "../fixtures");

const readFixture = (name: string) => readFileSync(join(fixturesDir, "bench", name), "utf8");

function readDir(subdir: string, ext: string): string[] {
  const dir = join(fixturesDir, subdir);
  const out: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(ext)) out.push(readFileSync(join(dir, f), "utf8"));
    }
  } catch {}
  return out;
}

export const short = [
  "echo hello",
  "program -short --long args",
  "npm run script",
  "pnpm install",
  "node script.js",
  "tsx ./main.ts",
  "bun test",
  "eslint .",
  "program -x && exec -y -- program2 -z",
  "cross-env NODE_ENV=production node -r pkg/config ./script.js",
  "dotenv -e .env3 -v VARIABLE=somevalue -- program",
  "npx --package @scope/pkg@0.6.0 --package pkg -- curl",
  "pnpm --silent run program script.js",
  "c8 --reporter=lcov --reporter text node --test --test-reporter=@org/rep",
  "NODE_ENV=production cross-env -- program --cache",
  "yarn --cwd components vitest -c vitest.components.config.ts",
  "changeset version && node ./scripts/deps/update-example-versions.js && pnpm install --no-frozen-lockfile && pnpm run format",
  'turbo run build --filter=astro --filter=create-astro --filter="@astrojs/*"',
  "biome ci --formatter-enabled=false --enforce-assist=false --reporter=github && eslint . --concurrency=auto && knip",
  'if test "$NODE_ENV" = "production" ; then make install ; fi',
  'f() { vite build "$@" || (echo content; exit 1;) }; f',
  "var=$(node ./script.js)",
  "var=`node ./script.js`;var=`node ./require.js`",
  '#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\nnpx lint-staged',
  'for S in "s"; do\n\tnpx rc@0.6.0\n\tnpx @scope/rc@0.6.0\ndone',
  "NODE_OPTIONS='--require pkg-a --require pkg-b' program",
];

export const advanced = [
  "for (( c=1; c<=5; c++ )); do echo $c; done",
  "select i in 1 2 3; do echo $i; done",
  '[[ "$lsb_dist" != "Ubuntu" || "$ver" < "14.04" ]]',
  "case a in a) echo A ;& *) echo star ;; esac",
  'echo $"hello world"',
  'declare -A map\nmap[key]="value"\necho "${map[key]}"',
  'if [[ $(cat $file) =~ $regex ]]; then\n    version="${BASH_REMATCH[1]}"\nfi',
  "node --maxWorkers=\"$(node -e 'process.stdout.write(os.cpus().length.toString())')\"",
  '[ "$CF_PAGES" = "1" ] && find dist -mindepth 2 -type f -name \'index.html\' -exec bash -c \'f="$1"; d=$(dirname "$f"); bn=$(basename "$d"); mv -v "$f" "$d/../$bn.html"\' _ {} \\; || true',
  'caddy run --config - <<< \'{"apps":{"http":{"servers":{"srv0":{"listen":[":8003"]}}}}}\'',
  'pnpm exec "cat package.json | jq -r \'\\\"\\\\(.name)@\\\\(.version)\\\"\'" | sort',
  "echo data | tee >(grep pattern > matches.txt) >(wc -l > count.txt) > /dev/null",
  "wc -c <(echo abc && echo def)",
  'case "$Z" in\n  ab*|cd*) ef ;;\nesac',
];

export const installers = readDir("installers", ".sh");

export const large = readDir("large", ".sh");

export const specialized: [string, string[]][] = [
  ["word-parts", [readFixture("word-parts.sh")]],
  ["globs", [readFixture("globs.sh")]],
  ["param-expansion", [readFixture("param-expansion.sh")]],
  ["arithmetic", [readFixture("arithmetic.sh")]],
  ["test-expressions", [readFixture("test-expressions.sh")]],
  ["heredoc-expansion", [readFixture("heredoc-expansion.sh")]],
  ["assignments", [readFixture("assignments.sh")]],
  ["dedicated-nodes", [readFixture("dedicated-nodes.sh")]],
];

export const workloads = new Map([
  ["short", short],
  ["advanced", advanced],
  ["medium", installers],
  ["large", large],
  ...specialized,
]);
