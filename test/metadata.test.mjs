import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { GROK_MODELS } from "../dist/schema.js";
import { CODEX_GROK_VERSION } from "../dist/version.js";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const readJson = async (file) => JSON.parse(await read(file));

function check(file, field, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${file}:${field} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

function captures(contents, pattern) {
  return [...contents.matchAll(pattern)].map((match) => match[1]);
}

function checkCopies(file, field, contents, pattern, expected) {
  check(file, field, captures(contents, pattern), [expected]);
}

test("later stale public pins report their file and field", () => {
  assert.throws(
    () =>
      checkCopies(
        "README.md",
        "release tag",
        "releases/tag/v1.2.3\nreleases/tag/v1.2.2",
        /releases\/tag\/(\S+)/g,
        "v1.2.3",
      ),
    (error) => {
      assert.equal(
        error.message.split("\n", 1)[0],
        'README.md:release tag expected ["v1.2.3"], received ["v1.2.3","v1.2.2"]',
      );
      return true;
    },
  );
});

test("release version copies match package.json", async () => {
  const [pkg, lock, plugin, mcp, readme, security, changelog, website, bugReport] =
    await Promise.all([
      readJson("package.json"),
      readJson("package-lock.json"),
      readJson("plugins/codex-grok-mcp/.codex-plugin/plugin.json"),
      readJson("plugins/codex-grok-mcp/.mcp.json"),
      read("README.md"),
      read("SECURITY.md"),
      read("CHANGELOG.md"),
      read("docs/index.html"),
      read(".github/ISSUE_TEMPLATE/bug-report.yml"),
    ]);
  const version = pkg.version;

  check("package-lock.json", "version", lock.version, version);
  check("package-lock.json", 'packages[""].version', lock.packages?.[""]?.version, version);
  check("src/version.ts", "CODEX_GROK_VERSION", CODEX_GROK_VERSION, version);
  check(
    "plugins/codex-grok-mcp/.codex-plugin/plugin.json",
    "version base",
    plugin.version?.split("+", 1)[0],
    version,
  );
  check(
    "plugins/codex-grok-mcp/.mcp.json",
    "mcpServers.grok.args package pin",
    (mcp.mcpServers?.grok?.args ?? [])
      .filter((argument) => argument.startsWith("--package="))
      .map((argument) => argument.slice("--package=".length)),
    [`${pkg.name}@${version}`],
  );

  for (const [field, pattern, expected] of [
    ["release tag", /releases\/tag\/([^\"]+)/g, `v${version}`],
    ["release badge label", /releases\/tag\/[^\"]+\">([^<]+)<\/a>/g, `v${version}`],
    [
      "supported public beta package",
      /supported public beta is the exact npm package `codex-grok-mcp@([^`]+)`/g,
      version,
    ],
    ["marketplace release ref", /marketplace add Fato07\/codex-grok-mcp --ref (\S+)/g, `v${version}`],
    ["plugin package pin", /The plugin runs only `codex-grok-mcp@([^`]+)`/g, version],
    ["direct MCP package pin", /codex mcp add grok .*--package=codex-grok-mcp@(\S+)/g, version],
    ["doctor package pin", /--package=codex-grok-mcp@(\S+) -- codex-grok-mcp --doctor/g, version],
    [
      "pair package pin",
      /--package=codex-grok-mcp@(\S+) -- \\\s+codex-grok-mcp pair/g,
      version,
    ],
    ["companion connect package pin", /@(\S+) -- codex-grok-bridge connect/g, version],
    ["bridge unpair package pin", /@(\S+) -- codex-grok-bridge unpair/g, version],
    ["MCP unpair package pin", /@(\S+) -- codex-grok-mcp unpair/g, version],
  ]) {
    checkCopies("README.md", field, readme, pattern, expected);
  }

  const probePins = captures(readme, /codex-grok-mcp@(\S+) -- codex-grok-bridge probe/g);
  check("README.md", "companion probe package pins", probePins, [version, version]);
  const runPins = captures(readme, /codex-grok-mcp@(\S+) -- codex-grok-bridge run/g);
  check("README.md", "companion run package pins", runPins, [version, "beta"]);
  checkCopies(
    "SECURITY.md",
    "supported public beta",
    security,
    /^`([^`]+)` is the supported public beta\./gm,
    version,
  );
  check(
    "CHANGELOG.md",
    "latest release heading",
    changelog.match(/^## \[([^\]]+)\]/m)?.[1],
    version,
  );
  checkCopies(
    "docs/index.html",
    "softwareVersion",
    website,
    /\"softwareVersion\": \"([^\"]+)\"/g,
    version,
  );
  checkCopies(
    "docs/index.html",
    "visible version badge",
    website,
    /<span class=\"version\">v([^<]+)<\/span>/g,
    version,
  );
  checkCopies(
    "docs/index.html",
    "marketplace release ref",
    website,
    /codex plugin marketplace add Fato07\/codex-grok-mcp --ref v([^<\s]+)/g,
    version,
  );
  checkCopies(
    ".github/ISSUE_TEMPLATE/bug-report.yml",
    "environment placeholder",
    bugReport,
    /placeholder: codex-grok-mcp ([^;]+);/g,
    version,
  );
});

test("documented Grok models match the shared finite tuple", async () => {
  const readme = await read("README.md");
  const row = readme.match(/^\| `GROK_MCP_MODEL` \| `([^`]+)` \| (.+) \|$/m);
  assert.ok(row, "README.md:GROK_MCP_MODEL row is missing");

  check("README.md", "GROK_MCP_MODEL default", row[1], GROK_MODELS[0]);
  check(
    "README.md",
    "GROK_MCP_MODEL allowed models",
    [...row[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]),
    [...GROK_MODELS],
  );
});
