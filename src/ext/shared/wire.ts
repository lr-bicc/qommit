import type { FileContent } from "../../core/types";

const CHUNK = 0x8000;

/** Encodes bytes as Base64 without Buffer, so it also works in a service worker. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export type WireContent = { text: string } | { base64: string };

export function toWire(content: FileContent): WireContent {
  return typeof content === "string" ? { text: content } : { base64: bytesToBase64(content) };
}

export function fromWire(content: WireContent): FileContent {
  return "text" in content ? content.text : base64ToBytes(content.base64);
}
