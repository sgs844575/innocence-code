import { describe, expect, it } from "vitest";
import { parseSSEData } from "../src/sse";

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of iter) out.push(s);
  return out;
}

function chunksOf(text: string, size: number): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return (async function* () {
    while (i < text.length) {
      yield encoder.encode(text.slice(i, i + size));
      i += size;
    }
  })();
}

describe("parseSSEData", () => {
  it("yields data payloads across arbitrary chunk boundaries", async () => {
    const raw = 'data: {"a":1}\n\ndata: {"b":2}\n\nevent: ping\ndata: [DONE]\n\n';
    const out = await collect(parseSSEData(chunksOf(raw, 5)));
    expect(out).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });

  it("handles CRLF line endings and ignores bare non-data lines", async () => {
    const raw = "event: x\r\ndata: y\r\n\r\n2\r\n";
    const out = await collect(parseSSEData(chunksOf(raw, 3)));
    expect(out).toEqual(["y"]);
  });

  it("yields a final payload without trailing newline", async () => {
    const out = await collect(parseSSEData(chunksOf("data: tail", 4)));
    expect(out).toEqual(["tail"]);
  });

  it("ignores non-data lines", async () => {
    const raw = ": comment\nevent: message_start\ndata: x\n\n";
    const out = await collect(parseSSEData(chunksOf(raw, 3)));
    expect(out).toEqual(["x"]);
  });
});
