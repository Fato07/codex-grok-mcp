export const CODEX_GROK_VERSION = "0.2.0-beta.1";

export const BRIDGE_STATUS_PROTOCOL_VERSION = 3 as const;
export const BRIDGE_PROTOCOL_VERSIONS = [1, 2, BRIDGE_STATUS_PROTOCOL_VERSION] as const;
export const BRIDGE_CAPABILITIES = [
  "status",
  "list_bots",
  "read_bot",
  "send_message",
] as const;
