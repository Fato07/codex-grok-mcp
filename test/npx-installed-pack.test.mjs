import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { applyHermeticEnv, hermetic, scrubGatewayEnv } from "./hermetic-setup.mjs";
import {
  generatePairCode,
  parsePairCode,
  savePairingConfig,
} from "../dist/bridge-pairing.js";
import { CODEX_GROK_VERSION } from "../dist/version.js";

async function fingerprintTree(root) {
  const files = [];
  async function walk(dir, rel = "") {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const nextRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, nextRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = await readFile(path);
      const details = await lstat(path);
      files.push({
        path: nextRel,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        ino: details.ino,
        mtimeMs: details.mtimeMs,
        ctimeMs: details.ctimeMs,
      });
    }
  }
  await walk(root);
  return files;
}

function runNpm(args, options) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

async function runNpmAsync(args, options) {
  const child = spawn("npm", args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [status] = await once(child, "exit");
  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  if (status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed (${status}): ${err || out}`);
  }
  return { stdout: out, stderr: err };
}

function packageNameFromLockPath(path) {
  const tail = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const parts = tail.split("/");
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0];
}

async function packProductionTarballs(destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const shrinkwrap = JSON.parse(await readFile("npm-shrinkwrap.json", "utf8"));
  const packed = [];
  for (const [path, meta] of Object.entries(shrinkwrap.packages)) {
    if (path === "" || meta.dev === true) continue;
    const result = runNpm(
      ["pack", "--ignore-scripts", "--pack-destination", destination, resolve(path)],
      { cwd: process.cwd(), env: { ...process.env, npm_config_ignore_scripts: "true" } },
    );
    const filename = result.stdout.trim().split(/\s+/).at(-1);
    assert.ok(filename?.endsWith(".tgz"), `expected tarball from ${path}`);
    packed.push({
      name: packageNameFromLockPath(path),
      version: meta.version,
      filename,
      path: join(destination, filename),
      dependencies: meta.dependencies,
    });
  }
  assert.ok(packed.length > 0);
  return packed;
}

async function startLoopbackRegistry(packages) {
  const tarballs = new Map();
  const packuments = new Map();
  for (const pkg of packages) {
    const bytes = await readFile(pkg.path);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    tarballs.set(`/${pkg.name}/-/${pkg.filename}`, bytes);
    if (pkg.name.startsWith("@")) {
      const [scope, name] = pkg.name.split("/");
      tarballs.set(`/${scope}/${name}/-/${pkg.filename}`, bytes);
    }
    const versions = packuments.get(pkg.name) ?? [];
    versions.push({
      version: pkg.version,
      filename: pkg.filename,
      integrity,
      dependencies: pkg.dependencies,
    });
    packuments.set(pkg.name, versions);
  }

  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const tarball = tarballs.get(pathname);
    if (tarball !== undefined) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(tarball);
      return;
    }
    const name = pathname.slice(1);
    const versions = packuments.get(name);
    if (versions === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    const port = server.address().port;
    const body = {
      _id: name,
      name,
      "dist-tags": { latest: versions.at(-1).version },
      versions: Object.fromEntries(
        versions.map((version) => [
          version.version,
          {
            name,
            version: version.version,
            ...(version.dependencies === undefined ? {} : { dependencies: version.dependencies }),
            dist: {
              integrity: version.integrity,
              tarball: `http://127.0.0.1:${port}/${name}/-/${version.filename}`,
            },
          },
        ]),
      ),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

async function seedOfflineCache(cacheDir, registryUrl, specs) {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  for (const spec of specs) {
    await runNpmAsync(
      [
        "cache",
        "add",
        spec,
        "--cache",
        cacheDir,
        "--registry",
        registryUrl,
        "--replace-registry-host=never",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      {
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: cacheDir,
          npm_config_cache: cacheDir,
          NPM_CONFIG_REGISTRY: registryUrl,
          npm_config_registry: registryUrl,
          NPM_CONFIG_REPLACE_REGISTRY_HOST: "never",
          NPM_CONFIG_OFFLINE: "false",
          npm_config_ignore_scripts: "true",
        },
      },
    );
  }
}

test("npx offline tarball install gets past the candidate pack check", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "codex-grok-npx-pack-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  await chmod(sandbox, 0o700);

  const home = join(sandbox, "home");
  const configHome = join(sandbox, "config");
  const dataHome = join(sandbox, "data");
  const stateHome = join(sandbox, "state");
  const cache = join(sandbox, "npm-cache");
  const packDest = join(sandbox, "artifact");
  const depDest = join(sandbox, "deps");
  for (const directory of [home, configHome, dataHome, stateHome, cache, packDest, depDest]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  const repoDist = resolve("dist");
  const distBeforePack = await fingerprintTree(repoDist);
  const packed = JSON.parse(
    runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", packDest], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        INIT_CWD: packDest,
        npm_config_update_notifier: "false",
      },
    }).stdout,
  );
  assert.deepEqual(
    await fingerprintTree(repoDist),
    distBeforePack,
    "npm pack rewrote repository dist/",
  );
  assert.equal(packed.length, 1);
  const tarball = join(packDest, packed[0].filename);
  const dependencies = await packProductionTarballs(depDest);
  const registry = await startLoopbackRegistry([
    ...dependencies,
    {
      name: "codex-grok-mcp",
      version: CODEX_GROK_VERSION,
      filename: basename(tarball),
      path: tarball,
    },
  ]);
  context.after(() => registry.close());
  await seedOfflineCache(cache, registry.url, [
    ...dependencies.map((pkg) => `${pkg.name}@${pkg.version}`),
    `codex-grok-mcp@${CODEX_GROK_VERSION}`,
    tarball,
  ]);

  const childEnv = { ...process.env };
  scrubGatewayEnv(childEnv);
  applyHermeticEnv(childEnv);
  childEnv.HOME = home;
  childEnv.XDG_CONFIG_HOME = configHome;
  childEnv.XDG_DATA_HOME = dataHome;
  childEnv.XDG_STATE_HOME = stateHome;
  childEnv.TMPDIR = hermetic.base;
  childEnv.SAND_DATA_ROOT = hermetic.dataRoot;
  childEnv.CODEX_GROK_TEST_HERMETIC = "1";
  childEnv.NPM_CONFIG_CACHE = cache;
  childEnv.npm_config_cache = cache;
  childEnv.NPM_CONFIG_OFFLINE = "true";
  childEnv.npm_config_offline = "true";
  childEnv.NPM_CONFIG_REGISTRY = registry.url;
  childEnv.npm_config_registry = registry.url;
  childEnv.NPM_CONFIG_REPLACE_REGISTRY_HOST = "always";
  childEnv.npm_config_replace_registry_host = "always";
  childEnv.NPM_CONFIG_FUND = "false";
  childEnv.NPM_CONFIG_AUDIT = "false";
  childEnv.npm_config_ignore_scripts = "true";
  childEnv.npm_config_update_notifier = "false";

  const pairingDir = join(configHome, "codex-grok-mcp");
  await mkdir(pairingDir, { recursive: true, mode: 0o700 });
  await savePairingConfig(
    parsePairCode(generatePairCode("ws://127.0.0.1:9/v1/connect")),
    join(pairingDir, "bridge.json"),
  );

  const child = spawn(
    "npx",
    ["--yes", "--offline", `--package=${tarball}`, "--", "codex-grok-bridge", "install"],
    {
      cwd: sandbox,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  const combined = `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`;

  assert.notEqual(code, 127, combined);
  assert.equal(signal, null, combined);
  assert.doesNotMatch(combined, /\bnpm run build\b/);
  assert.doesNotMatch(combined, />.*\bprepare\b/);
  assert.doesNotMatch(combined, /tsc[^\n]*(?:ENOENT|not found|127)/i);
  const report = JSON.parse(
    combined
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("{")) ?? "null",
  );
  assert.equal(typeof report?.error, "string", combined);
  assert.notEqual(report.error, "PAIRING_REQUIRED", combined);
  assert.notEqual(
    report.error,
    "install_failed",
    `pack check still failed as install_failed; output=${combined}`,
  );
  assert.equal(report.error, "candidate_invalid", combined);
  assert.deepEqual(
    await fingerprintTree(repoDist),
    distBeforePack,
    "npx install rewrote repository dist/",
  );
});
