import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import {
  decryptFrame,
  encryptFrame,
  generatePairCode,
  parsePairCode,
} from "../dist/bridge-pairing.js";
import { GrokBotGatewayError } from "../dist/grok-bot-gateway.js";
import { createRelayTransport } from "../dist/relay-transport.js";

test("relay transport treats a post-send 4404 close as uncertain without retry", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const config = parsePairCode(
    generatePairCode(`ws://127.0.0.1:${address.port}/v1/connect`),
  );
  const seenFrames = [];
  const seenRequests = [];

  server.on("connection", (socket) => {
    socket.once("message", (data, isBinary) => {
      assert.equal(isBinary, false);
      const frame = data.toString("utf8");
      seenFrames.push(frame);
      const request = JSON.parse(decryptFrame(config, "codex", frame).toString("utf8"));
      seenRequests.push(request);

      if (request.op === "list_bots") {
        socket.send(
          encryptFrame(
            config,
            "bridge",
            JSON.stringify({
              v: 1,
              id: request.id,
              op: "list_bots",
              ok: true,
              result: {
                bots: [{ id: "bot-1", name: "Ada", is_running: true }],
              },
            }),
          ),
        );
        return;
      }
      if (request.op === "read_bot") {
        socket.send(
          encryptFrame(
            config,
            "bridge",
            JSON.stringify({
              v: 2,
              id: request.id,
              op: "read_bot",
              ok: true,
              result: {
                bot_id: "bot-1",
                is_running: true,
                is_composing: false,
                awaiting_user: false,
                async_task_count: 0,
                running_subagent_count: 0,
                messages: [{ speaker: "bot", text: "private reply", timestamp_ms: 10 }],
                next_before_sequence: 7,
                truncated: false,
              },
            }),
          ),
        );
        return;
      }
      socket.close(4404, "malicious peer unavailable claim");
    });
  });

  const transport = createRelayTransport(config);
  try {
    assert.deepEqual(await transport.listBots(), [
      { id: "bot-1", name: "Ada", is_running: true },
    ]);
    assert.deepEqual(await transport.readBot("bot-1", { limit: 5, beforeSequence: 12 }), {
      bot_id: "bot-1",
      is_running: true,
      is_composing: false,
      awaiting_user: false,
      async_task_count: 0,
      running_subagent_count: 0,
      messages: [{ speaker: "bot", text: "private reply", timestamp_ms: 10 }],
      next_before_sequence: 7,
      truncated: false,
    });

    const secretMessage = "private message that must stay encrypted";
    await assert.rejects(
      transport.sendMessage("bot-1", secretMessage),
      (caught) => {
        assert(caught instanceof GrokBotGatewayError);
        assert.equal(caught.code, "UNAVAILABLE");
        assert.equal(caught.deliveryMayHaveOccurred, true);
        assert(!caught.message.includes(secretMessage));
        assert(!caught.message.includes(config.key));
        return true;
      },
    );

    assert.equal(seenRequests.length, 3);
    assert.deepEqual(seenRequests[1], {
      v: 2,
      id: seenRequests[1].id,
      issued_at_ms: seenRequests[1].issued_at_ms,
      op: "read_bot",
      args: { bot_id: "bot-1", limit: 5, before_sequence: 12 },
    });
    assert.equal(seenRequests[2].op, "send_message");
    assert.equal(seenRequests[2].args.message, secretMessage);
    assert.equal(seenFrames.some((frame) => frame.includes(secretMessage)), false);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((caught) => (caught ? reject(caught) : resolve()));
    });
  }
});

test("relay transport gives an actionable upgrade error for a legacy companion", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const config = parsePairCode(
    generatePairCode(`ws://127.0.0.1:${address.port}/v1/connect`),
  );
  server.on("connection", (socket) => {
    socket.once("message", () => socket.close(4400, "invalid frame"));
  });

  try {
    const transport = createRelayTransport(config);
    await assert.rejects(
      transport.readBot("bot-1", { limit: 5 }),
      (caught) => {
        assert(caught instanceof GrokBotGatewayError);
        assert.equal(caught.code, "UPGRADE_REQUIRED");
        assert.equal(caught.deliveryMayHaveOccurred, false);
        assert.match(caught.message, /update and restart/i);
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((caught) => (caught ? reject(caught) : resolve()));
    });
  }
});
