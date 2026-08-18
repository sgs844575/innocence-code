import type { HarnessPlugin } from "@innocencecode/harness-core";
import { editTool } from "./edit";
import { readTool } from "./read";
import { globTool, grepTool } from "./search";
import { writeTool } from "./write";

export { editTool } from "./edit";
export { readTool } from "./read";
export { globTool, grepTool } from "./search";
export { writeTool } from "./write";
export { resolveWithin, walkFiles, IGNORED_DIRS } from "./paths";

/** Filesystem tools plugin — registers Read/Write/Edit/Glob/Grep. */
export const fsPlugin: HarnessPlugin = {
  name: "tools-fs",
  activate(ctx) {
    ctx.registerTool(readTool);
    ctx.registerTool(writeTool);
    ctx.registerTool(editTool);
    ctx.registerTool(globTool);
    ctx.registerTool(grepTool);
  },
};
