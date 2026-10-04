import { realpathSync } from "node:fs";
import { TestRealDataRootError } from "./grok-bot-client.js";

export type OpenedFdResolver = (fd: number) => string;

let openedFdResolver: OpenedFdResolver | undefined;

export function setOpenedFdResolver(resolver?: OpenedFdResolver): void {
  openedFdResolver = resolver;
}

export function resolveOpenedFdPath(fd: number): string | undefined {
  if (openedFdResolver !== undefined) {
    try {
      return openedFdResolver(fd);
    } catch (caught) {
      if (caught instanceof TestRealDataRootError) throw caught;
      return undefined;
    }
  }
  try {
    return realpathSync(`/proc/self/fd/${String(fd)}`);
  } catch (caught) {
    if (caught instanceof TestRealDataRootError) throw caught;
    return undefined;
  }
}
