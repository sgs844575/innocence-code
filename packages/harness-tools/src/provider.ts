import type { JsonSchema } from "./types";

/** Tool description sent to the model (JSON Schema for parameters). */
export interface ToolSpec {
  name: string;
  description: string;
  /** Informational for the model; permission engine uses the Tool's flag. */
  readOnly?: boolean;
  parameters: JsonSchema;
}
