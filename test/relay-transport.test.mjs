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
      socket.close(4404, "malicious peer unavailable claim");
    });
  });

  const transport = createRelayTransport(config);
  try {
    assert.deepEqual(await transport.listBots(), [
      { id: "bot-1", name: "Ada", is_running: true },
    ]);

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

    assert.equal(seenRequests.length, 2);
    assert.equal(seenRequests[1].op, "send_message");
    assert.equal(seenRequests[1].args.message, secretMessage);
    assert.equal(seenFrames.some((frame) => frame.includes(secretMessage)), false);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((caught) => (caught ? reject(caught) : resolve()));
    });
  }
});
