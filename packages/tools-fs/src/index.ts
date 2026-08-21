import type { Context } from "@innocencecode/kernel";
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
export const FsPlugin = {
  name: "fs",
  apply(ctx: Context) {
    ctx.tools.register(readTool);
    ctx.tools.register(writeTool);
    ctx.tools.register(editTool);
    ctx.tools.register(globTool);
    ctx.tools.register(grepTool);
  },
};
export default FsPlugin;
