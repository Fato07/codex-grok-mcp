import { DurableObject } from "cloudflare:workers";

const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const MAX_FRAME_BYTES = 128 * 1024;
const INVALID_FRAME_CLOSE_CODE = 4400;
const PEER_UNAVAILABLE_CLOSE_CODE = 4404;
const TEXT_ENCODER = new TextEncoder();

type Role = "codex" | "bridge";
type RelayEnv = Env & { RELAY_ACCESS_TOKEN: string };

function isRole(value: string | null): value is Role {
  return value === "codex" || value === "bridge";
}

function close(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // The peer may already be disconnected.
  }
}

function frameSize(message: string | ArrayBuffer): number {
  return typeof message === "string"
    ? TEXT_ENCODER.encode(message).byteLength
    : message.byteLength;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeMasterToken(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
      (4 - (value.length % 4)) % 4,
    )}`;
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return bytes.byteLength === 32 && encodeBase64Url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function channelAccessToken(master: Uint8Array, channel: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    master,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    TEXT_ENCODER.encode(`codex-grok-mcp-relay:v1\0${channel}`),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function isAuthorized(
  request: Request,
  master: Uint8Array,
  channel: string,
): Promise<boolean> {
  const accessToken = await channelAccessToken(master, channel);
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(request.headers.get("Authorization") ?? "")),
    crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(`Bearer ${accessToken}`)),
  ]);
  return crypto.subtle.timingSafeEqual(provided, expected);
}

export class Relay extends DurableObject<RelayEnv> {
  fetch(request: Request): Response {
    const role = new URL(request.url).searchParams.get("role");
    if (!isRole(role) || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, { status: 400 });
    }

    for (const socket of this.ctx.getWebSockets(role)) {
      close(socket, 4000, "replaced");
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment(role);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const role: unknown = socket.deserializeAttachment();
    if (!isRole(typeof role === "string" ? role : null)) {
      close(socket, 1011, "invalid connection state");
      return;
    }

    const peerRole: Role = role === "codex" ? "bridge" : "codex";
    const peer = this.ctx
      .getWebSockets(peerRole)
      .find((candidate) => candidate.readyState === WebSocket.OPEN);

    if (!peer) {
      close(socket, PEER_UNAVAILABLE_CLOSE_CODE, "peer unavailable");
      return;
    }

    if (frameSize(message) > MAX_FRAME_BYTES) {
      close(socket, 1009, "frame too large");
      return;
    }

    peer.send(message);
  }

  webSocketClose(socket: WebSocket, code: number, _reason: string, _wasClean: boolean): void {
    const role: unknown = socket.deserializeAttachment();
    if (role !== "bridge") return;

    const peer = this.ctx
      .getWebSockets("codex")
      .find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!peer) return;

    const rejectedFrame = code === INVALID_FRAME_CLOSE_CODE;
    close(
      peer,
      rejectedFrame ? INVALID_FRAME_CLOSE_CODE : PEER_UNAVAILABLE_CLOSE_CODE,
      rejectedFrame ? "peer rejected frame" : "peer unavailable",
    );
  }

  webSocketError(socket: WebSocket, _error: unknown): void {
    close(socket, 1011, "websocket error");
  }
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    if (request.headers.has("Origin")) {
      return new Response(null, { status: 403 });
    }

    const url = new URL(request.url);
    const match = /^\/v1\/connect\/([^/]+)$/.exec(url.pathname);

    if (!match) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== "GET") {
      return new Response(null, { status: 405 });
    }
    if (!CHANNEL_PATTERN.test(match[1])) {
      return new Response(null, { status: 400 });
    }

    const roles = url.searchParams.getAll("role");
    if (roles.length !== 1 || !isRole(roles[0])) {
      return new Response(null, { status: 400 });
    }
    const master = decodeMasterToken(env.RELAY_ACCESS_TOKEN);
    if (master === undefined) {
      return new Response(null, { status: 503 });
    }
    if (!(await isAuthorized(request, master, match[1]))) {
      return new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="codex-grok-relay"' },
      });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, { status: 426 });
    }

    return env.RELAY.getByName(match[1]).fetch(request);
  },
} satisfies ExportedHandler<RelayEnv>;
