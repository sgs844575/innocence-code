import type { Context } from "@innocencecode/kernel";

/** Severity levels, ordered `debug < info < warn < error`. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** One record delivered to every interested sink. */
export interface LogEntry {
  level: LogLevel;
  message: string;
  data?: unknown;
  /** Capture time in `Date.now()` milliseconds since the epoch. */
  at: number;
}

/** Consumer of published entries; return values are ignored. */
export type LogSink = (entry: LogEntry) => void;

/** Options accepted when registering a sink. */
export interface AddSinkOptions {
  /** Lowest level delivered to this sink; defaults to `debug`. */
  minLevel?: LogLevel;
}

/** Logging service published by {@link LoggerPlugin} under `"logger"`. */
export interface LoggerService {
  /** Publish one entry to every sink whose threshold allows it. */
  log(level: LogLevel, message: string, data?: unknown): void;
  /**
   * Register a sink and return its disposer. The sink is additionally
   * attached to the fiber running the plugin, so unloading that fiber
   * removes it even when the disposer is never called.
   */
  addSink(sink: LogSink, options?: AddSinkOptions): () => void;
}

/** Numeric rank of each level; a higher rank means more severe. */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** One registered sink together with its delivery threshold. */
interface SinkRecord {
  sink: LogSink;
  threshold: number;
}

/**
 * Minimal logging plugin for the plugin kernel.
 *
 * `apply` publishes a {@link LoggerService} under `"logger"` on the scope
 * owning the plugin context and returns the withdraw handle, so the service
 * disappears when the plugin fiber unwinds. Sinks registered through the
 * service are cleaned up on the same unwind.
 */
export const LoggerPlugin: { name: "kernel-logger"; apply(ctx: Context): () => void } = {
  name: "kernel-logger",
  apply(ctx) {
    const sinks: SinkRecord[] = [];

    function removeSink(record: SinkRecord): void {
      const index = sinks.indexOf(record);
      if (index >= 0) sinks.splice(index, 1);
    }

    const service: LoggerService = {
      log(level, message, data) {
        // Without sinks there is nothing to observe; stay silent.
        if (sinks.length === 0) return;
        const entry: LogEntry = { level, message, at: Date.now() };
        if (data !== undefined) entry.data = data;
        const rank = LEVEL_RANK[level];
        // Deliver over a snapshot so a sink mutating the list while it is
        // being served cannot reorder or skip the remaining sinks.
        for (const record of [...sinks]) {
          if (rank < record.threshold) continue;
          record.sink(entry);
        }
      },
      addSink(sink, options) {
        const record: SinkRecord = {
          sink,
          threshold: LEVEL_RANK[options?.minLevel ?? "debug"],
        };
        sinks.push(record);
        // Attach the sink to the fiber of this plugin context: the effect
        // disposer drops it when the fiber unwinds, independent of the
        // disposer returned below.
        const detach = ctx.effect(() => () => removeSink(record), "logger sink");
        return () => {
          removeSink(record);
          void detach();
        };
      },
    };

    return ctx.provide("logger", service);
  },
};
