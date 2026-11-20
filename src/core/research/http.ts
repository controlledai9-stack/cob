/** Stream limits apply even when a server omits or lies about Content-Length. */
export async function boundedBody(
  response: Response,
  cap: number,
): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > cap) {
    await response.body?.cancel();
    throw new Error("Response exceeds size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new Error("Response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export const userAgent =
  "Cobble-Research/1.0 (local academic source discovery)";
