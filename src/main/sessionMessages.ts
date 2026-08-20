// Message mutation responsibility of the session facade: appending one live
// message to a record (count, timestamp, first-user-message retitle) and
// patching an existing message in place. Order promotion and index
// persistence stay in the facade — they belong to the store, not the message.
import type { SessionRecord } from "./sessionIndexStore";
import { messageText, type ChatMessage } from "../shared/ipc";

/**
 * Appends a live message to the record: bumps the count and timestamp and
 * retitles an untitled session from the first user message (first line,
 * capped at 24 chars, like most chat clients).
 */
export function appendSessionMessage(record: SessionRecord, message: ChatMessage): void {
  record.messages.push(message);
  record.messageCount = record.messages.length;
  record.updatedAt = Date.now();
  if (record.title === "新会话" && message.role === "user") {
    record.title = messageText(message.parts).split("\n")[0].slice(0, 24) || "新会话";
  }
}

/** Applies a partial patch or mutator to one message of the record (no-op when absent). */
export function updateSessionMessage(
  record: SessionRecord,
  messageId: string,
  patch: Partial<ChatMessage> | ((message: ChatMessage) => void),
): void {
  const message = record.messages.find((m) => m.id === messageId);
  if (!message) return;
  if (typeof patch === "function") patch(message);
  else Object.assign(message, patch);
}
