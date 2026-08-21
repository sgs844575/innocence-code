/**
 * Parses an HTTP body stream into SSE `data:` payload strings. Shared wire
 * plumbing for the native providers; `event:`/comment lines are ignored —
 * consumers that need Anthropic event names get them inside the JSON payloads.
 */
export async function* parseSSEData(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const source =
    typeof (body as ReadableStream<Uint8Array>).getReader === "function"
      ? streamToAsyncIterable(body as ReadableStream<Uint8Array>)
      : (body as AsyncIterable<Uint8Array>);

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      const data = sseDataOf(line);
      if (data !== undefined) yield data;
    }
  }
  const tail = (buffer + decoder.decode()).replace(/\r$/, "");
  const data = sseDataOf(tail);
  if (data !== undefined) yield data;
}

function sseDataOf(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  return line.slice(5).trimStart();
}

async function* streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
