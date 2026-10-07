import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  const [pkg, lock, shrinkwrap, plugin, mcp, readme, security, changelog, website, bugReport] =
    await Promise.all([
      readJson("package.json"),
      readJson("package-lock.json"),
      readJson("npm-shrinkwrap.json"),
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
  check("npm-shrinkwrap.json", "matches package-lock.json", shrinkwrap, lock);
  check(
    "package.json",
    "files includes npm-shrinkwrap.json",
    pkg.files?.includes("npm-shrinkwrap.json"),
    true,
  );
  check("package.json", "scripts.prepare", pkg.scripts?.prepare, undefined);
  check("package.json", "scripts.prepack", pkg.scripts?.prepack, "npm run build");
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
  check(
    "plugins/codex-grok-mcp/.mcp.json",
    "offline candidate-test passthrough",
    (mcp.mcpServers?.grok?.env_vars ?? []).filter((name) => name.startsWith("NPM_CONFIG_")),
    [
      "NPM_CONFIG_CACHE",
      "NPM_CONFIG_OFFLINE",
      "NPM_CONFIG_REGISTRY",
      "NPM_CONFIG_REPLACE_REGISTRY_HOST",
    ],
  );

  for (const [field, pattern, expected] of [
    ["release tag", /releases\/tag\/([^\"]+)/g, `v${version}`],
    ["release badge label", /releases\/tag\/[^\"]+\">([^<]+)<\/a>/g, `v${version}`],
    [
      "supported release package",
      /supported release is the exact npm package `codex-grok-mcp@([^`]+)`/g,
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
    "supported release",
    security,
    /^`([^`]+)` is the supported release\./gm,
    version,
  );
  const changelogHeadings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1]);
  check(
    "CHANGELOG.md",
    "latest release heading",
    changelogHeadings.find((heading) => heading !== "Unreleased"),
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

test("npm pack excludes attachment test-hooks files", async () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const sourceDist = join(repo, "dist");
  const distMtimes = async (dir) => {
    const names = (await readdir(dir)).sort();
    const times = {};
    for (const name of names) times[name] = (await stat(join(dir, name))).mtimeMs;
    return times;
  };
  const before = await distMtimes(sourceDist);
  const dest = await mkdtemp(join(tmpdir(), "codex-grok-pack-"));
  try {
    const pkgDir = join(dest, "src-pkg");
    const packed = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
    delete packed.scripts?.prepublishOnly;
    const packedDist = join(pkgDir, "dist");
    await mkdir(packedDist, { recursive: true });
    for (const name of Object.keys(before)) {
      await writeFile(join(packedDist, name), await readFile(join(sourceDist, name)));
    }
    await writeFile(join(pkgDir, "package.json"), `${JSON.stringify(packed, null, 2)}\n`);
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--json", "--ignore-scripts", `--pack-destination=${dest}`],
      {
        cwd: pkgDir,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          INIT_CWD: pkgDir,
          npm_config_update_notifier: "false",
          npm_config_ignore_scripts: "true",
        },
      },
    );
    const packs = JSON.parse(stdout);
    const files = packs[0]?.files?.map((entry) => entry.path) ?? [];
    assert.equal(
      files.some((path) => path.includes("test-hooks")),
      false,
      `published files include test-hooks: ${files.filter((path) => path.includes("test-hooks")).join(", ")}`,
    );
    const tarball = join(dest, packs[0].filename);
    await execFileAsync("tar", ["-xzf", tarball, "-C", dest]);
    const distDir = join(dest, "package", "dist");
    const distFiles = await readdir(distDir);
    const allowedTestEnv = (name) =>
      name.startsWith("grok-bot-client.") || name.startsWith("bridge-lifecycle.");
    const hits = [];
    for (const name of distFiles) {
      const text = await readFile(join(distDir, name), "utf8");
      if (text.includes("Symbol.for")) hits.push(`${name}: Symbol.for`);
      if (text.includes("test-hooks")) hits.push(`${name}: test-hooks`);
      if (text.includes("resetAttachmentSessionStore")) {
        hits.push(`${name}: resetAttachmentSessionStore`);
      }
      if (text.includes("CODEX_GROK_TEST_") && allowedTestEnv(name) === false) {
        hits.push(`${name}: CODEX_GROK_TEST_`);
      }
    }
    assert.deepEqual(hits, []);
    const packedText = Object.fromEntries(
      await Promise.all(distFiles.map(async (name) => [name, await readFile(join(distDir, name), "utf8")])),
    );
    const sandRootFiles = distFiles.filter((name) => packedText[name].includes("sandRoots"));
    assert.deepEqual(
      sandRootFiles.filter((name) => name.startsWith("attachments.") === false),
      [],
      `sandRoots leaked outside attachments: ${sandRootFiles.join(", ")}`,
    );
    for (const name of ["index.js", "bridge-companion.js"]) {
      const text = packedText[name];
      assert.equal(text.includes("sandRoots"), false, `${name} exposes sandRoots`);
      assert.equal(text.includes("attachmentGuard"), false, `${name} exposes attachmentGuard`);
      assert.equal(text.includes("homes:"), false, `${name} exposes homes override`);
    }
    const gateway = packedText["grok-bot-gateway.js"];
    assert.equal(gateway.includes("sandRoots"), false, "grok-bot-gateway.js exposes sandRoots");
    assert.equal(gateway.includes("homes:"), false, "grok-bot-gateway.js exposes homes override");
    assert.equal(
      files.some((path) => path.includes("real-root-fs-spy")),
      false,
      "packed files include real-root-fs-spy",
    );
    for (const name of distFiles) {
      assert.equal(
        packedText[name].includes("real-root-fs-spy"),
        false,
        `${name} mentions real-root-fs-spy`,
      );
    }
    assert.deepEqual(await distMtimes(sourceDist), before);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
