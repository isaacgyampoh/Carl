/**
 * The device secret's home.
 *
 * It lives in the operating system's credential store — Keychain on macOS, Credential
 * Manager on Windows, the Secret Service on Linux — and never in the local database or a
 * configuration file. The local SQLite file sits on a machine that is physically exposed:
 * a till on a counter is stolen in a way a server is not, and a secret in a file next to
 * the data is a secret that leaves with the laptop.
 *
 * These are the only three IPC commands the Rust host exposes for credentials.
 */

import { invoke } from '@tauri-apps/api/core';

export async function storeDeviceSecret(deviceId: string, secret: string): Promise<void> {
  await invoke('store_device_secret', { deviceId, secret });
}

/**
 * Reads the secret back.
 *
 * Returns null when there is none rather than throwing: "this terminal has not been
 * activated" is an ordinary state on first run, not an error.
 */
export async function readDeviceSecret(deviceId: string): Promise<string | null> {
  try {
    return await invoke<string>('read_device_secret', { deviceId });
  } catch {
    return null;
  }
}

/** Called when a terminal is revoked or reset. */
export async function clearDeviceSecret(deviceId: string): Promise<void> {
  await invoke('clear_device_secret', { deviceId });
}
