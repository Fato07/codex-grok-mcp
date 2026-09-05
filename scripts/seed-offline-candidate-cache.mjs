#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

function fail(message) {
  throw new Error(message);
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) fail("usage_error");
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const value = equals === -1 ? arguments_[index + 1] : argument.slice(equals + 1);
    if (equals === -1) index += 1;
    if (!value || values.has(name)) fail("usage_error");
    values.set(name, value);
  }
  if (values.size !== 2 || !values.has("artifact") || !values.has("cache")) {
    fail("usage_error");
  }
  return {
    artifact: values.get("artifact"),
    cache: values.get("cache"),
  };
}

function currentUid() {
  const uid = process.getuid?.();
  if (uid === undefined) fail("posix_permissions_required");
  return uid;
}

async function assertTrustedDirectoryChain(path, code) {
  let cursor = await realpath(path).catch(() => fail(code));
  while (true) {
    const details = await lstat(cursor).catch(() => fail(code));
    const mode = details.mode & 0o7777;
    const trustedOwner = details.uid === currentUid() || details.uid === 0;
    const writable = (mode & 0o022) !== 0;
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      !trustedOwner ||
      (writable && ((mode & 0o1000) === 0 || details.uid !== 0))
    ) {
      fail(code);
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validArtifactDetails(details) {
  return (
    details.isFile() &&
    !details.isSymbolicLink() &&
    details.nlink === 1 &&
    details.uid === currentUid() &&
    (details.mode & 0o022) === 0 &&
    details.size > 0
  );
}

async function readCandidateArtifact(path, expectedName) {
  if (!isAbsolute(path) || basename(path) !== expectedName) fail("artifact_invalid");
  const inputDetails = await lstat(path).catch(() => fail("artifact_invalid"));
  if (inputDetails.isSymbolicLink()) fail("artifact_invalid");
  const canonical = await realpath(path).catch(() => fail("artifact_invalid"));
  await assertTrustedDirectoryChain(dirname(canonical), "artifact_invalid");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(canonical, fsConstants.O_RDONLY | noFollow).catch(() =>
    fail("artifact_invalid"),
  );
  try {
    const before = await handle.stat();
    if (!validArtifactDetails(before) || !sameIdentity(inputDetails, before)) {
      fail("artifact_invalid");
    }
    const bytes = await handle.readFile();
    const [after, pathDetails] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !validArtifactDetails(after) ||
      !sameIdentity(before, after) ||
      !sameIdentity(after, pathDetails) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== after.size
    ) {
      fail("artifact_invalid");
    }
    return { bytes, path: canonical };
  } finally {
    await handle.close();
  }
}

async function validateEmptyCache(path) {
  if (!isAbsolute(path)) fail("cache_invalid");
  const inputDetails = await lstat(path).catch(() => fail("cache_invalid"));
  if (inputDetails.isSymbolicLink()) fail("cache_invalid");
  const canonical = await realpath(path).catch(() => fail("cache_invalid"));
  await assertTrustedDirectoryChain(canonical, "cache_invalid");
  const details = await lstat(canonical).catch(() => fail("cache_invalid"));
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    details.uid !== currentUid() ||
    (details.mode & 0o777) !== 0o700 ||
    !sameIdentity(inputDetails, details) ||
    (await readdir(canonical)).length !== 0
  ) {
    fail("cache_invalid");
  }
  return { device: details.dev, inode: details.ino, path: canonical };
}

async function assertCacheIdentity(cache) {
  const details = await lstat(cache.path).catch(() => fail("cache_invalid"));
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    details.uid !== currentUid() ||
    (details.mode & 0o777) !== 0o700 ||
    details.dev !== cache.device ||
    details.ino !== cache.inode
  ) {
    fail("cache_invalid");
  }
  await assertTrustedDirectoryChain(cache.path, "cache_invalid");
}

function appendBounded(chunks, chunk) {
  const buffered = Buffer.concat([...chunks, chunk]);
  chunks.length = 0;
  chunks.push(buffered.subarray(Math.max(0, buffered.length - MAX_CHILD_OUTPUT_BYTES)));
}

async function runNpmCacheAdd(spec, cache, registry) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(
    command,
    [
      "cache",
      "add",
      spec,
      "--cache",
      cache,
      "--registry",
      registry,
      "--replace-registry-host=never",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NPM_CONFIG_CACHE: cache,
        NPM_CONFIG_OFFLINE: "false",
        NPM_CONFIG_REGISTRY: registry,
        NPM_CONFIG_REPLACE_REGISTRY_HOST: "never",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => appendBounded(stdout, chunk));
  child.stderr.on("data", (chunk) => appendBounded(stderr, chunk));
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", resolveCode);
  });
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").trim().split("\n").at(-1);
    fail(detail ? `cache_seed_failed: ${detail}` : "cache_seed_failed");
  }
}

function packageNameFromLockPath(path) {
  const tail = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const parts = tail.split("/");
  const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0];
  if (
    !name ||
    name.endsWith("/") ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)
  ) {
    fail("shrinkwrap_invalid");
  }
  return name;
}

function productionPackages(shrinkwrap) {
  if (
    shrinkwrap?.lockfileVersion !== 3 ||
    typeof shrinkwrap.packages !== "object" ||
    shrinkwrap.packages === null ||
    Array.isArray(shrinkwrap.packages)
  ) {
    fail("shrinkwrap_invalid");
  }
  const packages = [];
  for (const [path, value] of Object.entries(shrinkwrap.packages)) {
    if (path === "" || value?.dev === true) continue;
    if (
      !path.startsWith("node_modules/") ||
      typeof value?.version !== "string" ||
      !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(
        value.version,
      ) ||
      typeof value?.resolved !== "string" ||
      !value.resolved.startsWith("https://registry.npmjs.org/") ||
      typeof value?.integrity !== "string" ||
      !value.integrity.startsWith("sha512-")
    ) {
      fail("shrinkwrap_invalid");
    }
    packages.push({
      metadata: {
        name: packageNameFromLockPath(path),
        version: value.version,
        ...(value.dependencies === undefined ? {} : { dependencies: value.dependencies }),
        ...(value.optionalDependencies === undefined
          ? {}
          : { optionalDependencies: value.optionalDependencies }),
        ...(value.peerDependencies === undefined
          ? {}
          : { peerDependencies: value.peerDependencies }),
        ...(value.peerDependenciesMeta === undefined
          ? {}
          : { peerDependenciesMeta: value.peerDependenciesMeta }),
        ...(value.engines === undefined ? {} : { engines: value.engines }),
        ...(value.bin === undefined ? {} : { bin: value.bin }),
        ...(value.os === undefined ? {} : { os: value.os }),
        ...(value.cpu === undefined ? {} : { cpu: value.cpu }),
      },
      resolved: value.resolved,
      integrity: value.integrity,
    });
  }
  return packages.sort((left, right) =>
    `${left.metadata.name}@${left.metadata.version}`.localeCompare(
      `${right.metadata.name}@${right.metadata.version}`,
    ),
  );
}

function packument(name, versions) {
  return Buffer.from(
    JSON.stringify({
      _id: name,
      name,
      "dist-tags": { latest: versions.at(-1).version },
      versions: Object.fromEntries(
        versions.map((version) => [
          version.version,
          {
            ...version,
            _id: `${name}@${version.version}`,
          },
        ]),
      ),
    }),
  );
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (!isAbsolute(arguments_.artifact) || !isAbsolute(arguments_.cache)) {
    fail("usage_error");
  }
  const inputArtifact = resolve(arguments_.artifact);
  const inputCache = resolve(arguments_.cache);
  const packageMetadata = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  if (
    packageMetadata?.name !== "codex-grok-mcp" ||
    typeof packageMetadata.version !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(
      packageMetadata.version,
    )
  ) {
    fail("package_metadata_invalid");
  }
  const expectedArtifact = `${packageMetadata.name}-${packageMetadata.version}.tgz`;
  const artifact = await readCandidateArtifact(inputArtifact, expectedArtifact);
  const cache = await validateEmptyCache(inputCache);
  const shrinkwrap = JSON.parse(
    await readFile(resolve(root, "npm-shrinkwrap.json"), "utf8"),
  );
  if (
    shrinkwrap.name !== packageMetadata.name ||
    shrinkwrap.version !== packageMetadata.version ||
    shrinkwrap.packages?.[""]?.name !== packageMetadata.name ||
    shrinkwrap.packages?.[""]?.version !== packageMetadata.version
  ) {
    fail("shrinkwrap_invalid");
  }

  const integrity = `sha512-${createHash("sha512").update(artifact.bytes).digest("base64")}`;
  const shasum = createHash("sha1").update(artifact.bytes).digest("hex");
  const dependencies = productionPackages(shrinkwrap);
  const dependencyVersions = new Map();
  for (const dependency of dependencies) {
    const versions = dependencyVersions.get(dependency.metadata.name) ?? [];
    versions.push({
      ...dependency.metadata,
      dist: {
        integrity: dependency.integrity,
        tarball: dependency.resolved,
      },
    });
    dependencyVersions.set(dependency.metadata.name, versions);
  }
  let registry;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", registry).pathname;
    const metadataPath = `/${packageMetadata.name}`;
    const tarballPath = `/${packageMetadata.name}/-/${expectedArtifact}`;
    if (pathname === metadataPath) {
      const body = Buffer.from(
        JSON.stringify({
          _id: packageMetadata.name,
          name: packageMetadata.name,
          "dist-tags": { latest: packageMetadata.version },
          versions: {
            [packageMetadata.version]: {
              ...packageMetadata,
              _id: `${packageMetadata.name}@${packageMetadata.version}`,
              dist: {
                integrity,
                shasum,
                tarball: `${registry}${packageMetadata.name}/-/${expectedArtifact}`,
              },
            },
          },
        }),
      );
      response.writeHead(200, {
        "content-length": body.length,
        "content-type": "application/json",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    let requestedPackage;
    try {
      requestedPackage = decodeURIComponent(pathname.slice(1));
    } catch {
      requestedPackage = undefined;
    }
    const dependencyPackument =
      requestedPackage === undefined ? undefined : dependencyVersions.get(requestedPackage);
    if (dependencyPackument !== undefined) {
      const body = packument(requestedPackage, dependencyPackument);
      response.writeHead(200, {
        "content-length": body.length,
        "content-type": "application/json",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (pathname === tarballPath) {
      response.writeHead(200, {
        "content-length": artifact.bytes.length,
        "content-type": "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : artifact.bytes);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not_found"}');
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") fail("registry_start_failed");
  registry = `http://127.0.0.1:${address.port}/`;

  try {
    await runNpmCacheAdd(
      `${packageMetadata.name}@${packageMetadata.version}`,
      cache.path,
      registry,
    );
    for (const dependency of dependencies) {
      await runNpmCacheAdd(
        `${dependency.metadata.name}@${dependency.metadata.version}`,
        cache.path,
        registry,
      );
    }
  } finally {
    await closeServer(server);
  }
  await assertCacheIdentity(cache);

  process.stdout.write(
    `${JSON.stringify({
      package: `${packageMetadata.name}@${packageMetadata.version}`,
      integrity,
      registry_url: registry,
      production_dependency_count: dependencies.length,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "cache_seed_failed"}\n`);
  process.exitCode = 1;
});
