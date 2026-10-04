const ATTACHMENT_TEST_HOOKS = Symbol.for("codex-grok-attachment-test-hooks");

function hooks() {
  const existing = globalThis[ATTACHMENT_TEST_HOOKS];
  if (typeof existing === "object" && existing !== null) return existing;
  const created = {};
  globalThis[ATTACHMENT_TEST_HOOKS] = created;
  return created;
}

export function setOpenedFdResolver(resolver) {
  const state = hooks();
  if (resolver === undefined) delete state.resolveOpenedFd;
  else state.resolveOpenedFd = resolver;
}

export function setAttachmentAccountHomes(homes) {
  const state = hooks();
  if (homes === undefined) delete state.accountHomes;
  else state.accountHomes = [...homes];
}
