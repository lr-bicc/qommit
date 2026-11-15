import type { FileContent } from "./types";

// Computes the git blob object id: SHA-1 over "blob <byteLength>\0" followed by the content bytes.
export async function gitBlobSha(content: FileContent): Promise<string> {
  const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const header = new TextEncoder().encode(`blob ${body.byteLength}\0`);
  const data = new Uint8Array(header.byteLength + body.byteLength);
  data.set(header, 0);
  data.set(body, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
