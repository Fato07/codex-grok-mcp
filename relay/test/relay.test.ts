import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds } from "cloudflare:test";
import { expect, it } from "vitest";

const CHANNEL = "AAAAAAAAAAAAAAAAAAAAAA";
const UNAVAILABLE_CHANNEL = "AAAAAAAAAAAAAAAAAAAAAQ";
const CAP_CHANNEL = "AAAAAAAAAAAAAAAAAAAABA";
const AUTHORIZATIONS: Record<string, string> = {
  [CHANNEL]: "Bearer oCZGsv3_Wa-CwwkEYxnF9Zvl9nzxLC3mTUDx4R23H2E",
  [UNAVAILABLE_CHANNEL]: "Bearer chjihmYNxBTJTqJG2OdkC2-BY78eR8KObXxeN1rmwQc",
  [CAP_CHANNEL]: "Bearer NhP4BGrMM7x-D5Rf7GSLEj3uIJenewrPcW_Vv3JC02w",
};
const AUTHORIZATION = AUTHORIZATIONS[CHANNEL] ?? "";

function event(socket: WebSocket, type: "close"): Promise<CloseEvent>;
function event(socket: WebSocket, type: "message"): Promise<MessageEvent>;
function event(socket: WebSocket, type: "close" | "message"): Promise<CloseEvent | MessageEvent> {
  return new Promise((resolve) => socket.addEventListener(type, resolve, { once: true }));
}

async function connect(channel: string, role: "codex" | "bridge"): Promise<WebSocket> {
  const response = await exports.default.fetch(`https://relay.test/v1/connect/${channel}?role=${role}`, {
    headers: { Authorization: AUTHORIZATIONS[channel] ?? "", Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();
  const socket = response.webSocket;
  if (!socket) throw new Error("missing WebSocket");
  socket.accept();
  socket.binaryType = "arraybuffer";
  return socket;
}

it("rejects browser and unauthenticated requests before creating a Durable Object", async () => {
  const url = `https://relay.test/v1/connect/${CHANNEL}?role=codex`;

  const missing = await exports.default.fetch(url, { headers: { Upgrade: "websocket" } });
  expect(missing.status).toBe(401);
  expect(missing.headers.get("WWW-Authenticate")).toBe('Bearer realm="codex-grok-relay"');

  expect(
    (await exports.default.fetch(url, {
      headers: { Authorization: "Bearer wrong-token", Upgrade: "websocket" },
    })).status,
  ).toBe(401);
  expect(
    (await exports.default.fetch(url, {
      headers: { Authorization: AUTHORIZATION, Origin: "https://example.test", Upgrade: "websocket" },
    })).status,
  ).toBe(403);
  expect(
    (await exports.default.fetch(
      `https://relay.test/v1/connect/${UNAVAILABLE_CHANNEL}?role=codex`,
      { headers: { Authorization: AUTHORIZATION, Upgrade: "websocket" } },
    )).status,
  ).toBe(401);
  expect(await listDurableObjectIds(env.RELAY)).toHaveLength(0);
});

it("validates, routes opaque frames, caps frames, reports availability, and replaces roles", async () => {
  expect((await exports.default.fetch("https://relay.test/nope")).status).toBe(404);
  expect(
    (await exports.default.fetch("https://relay.test/v1/connect/not-a-channel?role=codex", {
      headers: { Authorization: AUTHORIZATION, Upgrade: "websocket" },
    })).status,
  ).toBe(400);
  expect(
    (await exports.default.fetch("https://relay.test/v1/connect/AAAAAAAAAAAAAAAAAAAAAB?role=codex", {
      headers: { Authorization: AUTHORIZATION, Upgrade: "websocket" },
    })).status,
  ).toBe(400);
  expect(
    (await exports.default.fetch(`https://relay.test/v1/connect/${CHANNEL}?role=nope`, {
      headers: { Authorization: AUTHORIZATION, Upgrade: "websocket" },
    })).status,
  ).toBe(400);
  expect(
    (await exports.default.fetch(`https://relay.test/v1/connect/${CHANNEL}?role=codex`, {
      headers: { Authorization: AUTHORIZATION },
    })).status,
  ).toBe(426);

  const codex = await connect(CHANNEL, "codex");
  const bridge = await connect(CHANNEL, "bridge");

  const stringMessage = event(bridge, "message");
  codex.send("opaque");
  expect((await stringMessage).data).toBe("opaque");

  const binaryMessage = event(codex, "message");
  bridge.send(new Uint8Array([1, 2, 3]).buffer);
  expect(Array.from(new Uint8Array((await binaryMessage).data as ArrayBuffer))).toEqual([1, 2, 3]);

  const replaced = event(codex, "close");
  const replacement = await connect(CHANNEL, "codex");
  expect((await replaced).code).toBe(4000);

  const replacementMessage = event(replacement, "message");
  bridge.send("new socket");
  expect((await replacementMessage).data).toBe("new socket");

  const unavailable = await connect(UNAVAILABLE_CHANNEL, "codex");
  const unavailableClose = event(unavailable, "close");
  unavailable.send(new Uint8Array(128 * 1024 + 1));
  const unavailableEvent = await unavailableClose;
  expect(unavailableEvent.code).toBe(4404);
  expect(unavailableEvent.reason).toBe("peer unavailable");

  const cappedSender = await connect(CAP_CHANNEL, "codex");
  const cappedPeer = await connect(CAP_CHANNEL, "bridge");
  const cappedClose = event(cappedSender, "close");
  let oversizedForwarded = false;
  cappedPeer.addEventListener("message", () => {
    oversizedForwarded = true;
  });
  cappedSender.send(new Uint8Array(128 * 1024 + 1));
  expect((await cappedClose).code).toBe(1009);
  expect(oversizedForwarded).toBe(false);

  replacement.close(1000, "done");
  bridge.close(1000, "done");
  cappedPeer.close(1000, "done");
});
