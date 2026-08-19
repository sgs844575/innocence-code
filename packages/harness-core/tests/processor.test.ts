import { expect, it } from "vitest";
import { processMessage } from "../src/processor";
import { textMessage } from "../src/types";

it("runs processors by order and keeps registration order for ties", async () => {
  const calls: string[] = [];
  const processors = [
    { name: "late", order: 20, process: async (m: any) => { calls.push("late"); return m; } },
    { name: "first-a", order: 10, process: async (m: any) => { calls.push("first-a"); return m; } },
    { name: "first-b", order: 10, process: async (m: any) => { calls.push("first-b"); return m; } },
  ];

  await processMessage(textMessage("user", "hello"), processors, {
    signal: new AbortController().signal,
    provider: { id: "test", chat: async function* () {} },
    scope: { sessionId: "s1" },
  });

  expect(calls).toEqual(["first-a", "first-b", "late"]);
});

it("stops before history mutation when a processor fails", async () => {
  const error = new Error("processor failed");
  await expect(processMessage(
    textMessage("user", "hello"),
    [{ name: "broken", order: 0, process: async () => { throw error; } }],
    {
      signal: new AbortController().signal,
      provider: { id: "test", chat: async function* () {} },
      scope: { sessionId: "s1" },
    },
  )).rejects.toBe(error);
});
