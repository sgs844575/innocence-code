import type { Context } from "@innocencecode/kernel";
import type { Provider } from "@innocencecode/harness-providers";
import { ContextManager, type CompactionOptions } from "./context-manager";
import type { HarnessEvent } from "./events";
import { processMessage, type MessageProcessor } from "./processor";
import type { Message } from "./types";

// Services are typed on `Context` through declaration merging by their
// publisher (kernel ServiceTable contract). The member is live only while
// the session plugin fiber publishing it is active; before load and after
// its unwind the property is absent at runtime.
//
// HarnessEvent traffic is broadcast on the kernel event bus under
// "harness/event" (call-signature style, kernel Events contract).
declare module "@innocencecode/kernel" {
  interface Context {
    session: SessionService;
  }
  interface Events {
    "harness/event"(event: HarnessEvent): void;
  }
}

/** Session spine surface published by {@link SessionPlugin} under "session". */
export interface SessionService {
  /** Session-level message ledger; the caller (loop) owns every push. */
  readonly history: Message[];
  /**
   * Registers a message processor. Registration order is preserved
   * (registry registerMessageProcessor push semantics); the pipeline sorts
   * by `order` and breaks ties by registration order.
   */
  registerProcessor(p: MessageProcessor): void;
  /** Registered processors in registration order (read-only view). */
  processors(): readonly MessageProcessor[];
  /**
   * Runs the processor pipeline over one message and returns the processed
   * message. The service provides the pipeline only: callers decide which
   * inputs are real user input — tool-result turns fed back by the loop and
   * subagent inputs never pass through here, and the returned message is
   * NOT stored into {@link history} (the caller stores it).
   */
  processUserInput(input: Message, signal?: AbortSignal): Promise<Message>;
  /** Broadcasts one HarnessEvent on the kernel bus ("harness/event"). */
  emit(event: HarnessEvent): void;
  /** Compaction manager owned by the session. */
  readonly compactor: ContextManager;
}

/** Constructor options of the session spine plugin (per-session state). */
export interface SessionPluginOptions {
  /** Provider handed to the processor pipeline context. */
  provider: Provider;
  /**
   * Session id stamped on processor scopes. Host-minted (`sess-…`
   * semantics of the session identity), so the service never mints its own
   * counter that could collide with the host's.
   */
  sessionId: string;
  /** Options for the session-owned compaction ContextManager. */
  compaction?: Partial<CompactionOptions>;
}

/** Shape of the session spine plugin (kernel Plugin contract). */
export interface SessionPlugin {
  readonly name: "harness-session";
  apply(ctx: Context): () => void;
}

/**
 * Creates the session spine plugin for one session (the ledger, processors
 * and compactor are session state, so the plugin is created per session —
 * the permissions factory precedent). `apply` publishes the service under
 * "session", wires `emit` to broadcast on the kernel bus, and returns the
 * withdraw handle, so the service disappears — and the broadcast goes
 * inert — when the plugin fiber unwinds.
 */
export function createSessionPlugin(options: SessionPluginOptions): SessionPlugin {
  const processors: MessageProcessor[] = [];
  let broadcast: (event: HarnessEvent) => void = () => {};
  const service: SessionService = {
    history: [],
    registerProcessor: (p) => {
      processors.push(p);
    },
    processors: () => processors,
    processUserInput: (input, signal) =>
      processMessage(input, processors, {
        signal: signal ?? new AbortController().signal,
        provider: options.provider,
        scope: { sessionId: options.sessionId },
      }),
    emit: (event) => broadcast(event),
    compactor: new ContextManager(options.compaction ?? {}),
  };

  return {
    name: "harness-session",
    apply(ctx) {
      broadcast = (event) => ctx.emit("harness/event", event);
      const withdraw = ctx.provide("session", service);
      return () => {
        broadcast = () => {};
        withdraw();
      };
    },
  };
}
