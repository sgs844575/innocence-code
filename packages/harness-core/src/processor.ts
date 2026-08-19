import type { Provider } from "./provider";
import type { Message } from "./types";

export interface MessageProcessorContext {
  signal: AbortSignal;
  provider: Provider;
  scope: {
    sessionId: string;
  };
}

export interface MessageProcessor {
  name: string;
  order: number;
  process(message: Message, context: MessageProcessorContext): Promise<Message>;
}

export async function processMessage(
  message: Message,
  processors: readonly MessageProcessor[],
  context: MessageProcessorContext,
): Promise<Message> {
  const ordered = processors
    .map((processor, index) => ({ processor, index }))
    .sort((a, b) => a.processor.order - b.processor.order || a.index - b.index);

  let current = message;
  for (const { processor } of ordered) {
    current = await processor.process(current, context);
  }
  return current;
}
