/**
 * Isomorphic encoding helpers.
 *
 * `@carl/shared` is imported by the Next.js server, the browser bundle, the Tauri desktop
 * frontend and the test harness. `Buffer` exists in only one of those. Everything here is
 * built on primitives present in all four runtimes.
 */

/** Encodes bytes as base64url (RFC 4648 §5) — URL- and cookie-safe, no padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked to avoid blowing the argument limit of String.fromCharCode on large inputs.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(encoded: string): Uint8Array {
  const padded = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

export function base64UrlToUtf8(encoded: string): string {
  return new TextDecoder().decode(base64UrlToBytes(encoded));
}

/** Cryptographically secure random bytes, via WebCrypto (global in Node 19+ and browsers). */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** A v4 UUID from the platform CSPRNG. */
export function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Compares two strings in time independent of where they first differ.
 *
 * Used for device secrets and activation codes. A naive `===` returns faster the earlier the
 * mismatch occurs, which leaks the secret one character at a time to an attacker who can
 * measure response time.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Length is not secret, but returning early on it would still leak; fold it into the result.
  let mismatch = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return mismatch === 0;
}
