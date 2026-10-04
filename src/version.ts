export const CODEX_GROK_VERSION = "0.2.0-beta.9";

export const BRIDGE_STATUS_PROTOCOL_VERSION = 3 as const;
export const BRIDGE_ATTACHMENT_PROTOCOL_VERSION = 4 as const;
export const BRIDGE_PROTOCOL_VERSIONS = [1, 2, BRIDGE_STATUS_PROTOCOL_VERSION] as const;
export const BRIDGE_ADVERTISED_PROTOCOL_VERSIONS = [
  ...BRIDGE_PROTOCOL_VERSIONS,
  BRIDGE_ATTACHMENT_PROTOCOL_VERSION,
] as const;
export const BRIDGE_CAPABILITIES = [
  "status",
  "list_bots",
  "read_bot",
  "send_message",
] as const;
export const BRIDGE_ATTACHMENT_CAPABILITIES = [
  "attachment_send_v1",
  "attachment_read_v1",
] as const;
