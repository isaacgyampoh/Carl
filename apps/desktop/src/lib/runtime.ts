/**
 * Which runtime this code is executing in.
 *
 * Uses Tauri's own `isTauri()` rather than sniffing `window.__TAURI__` or a user agent. The
 * official check is maintained alongside the IPC bridge it reports on; a hand-rolled one
 * silently becomes wrong when the internals move, and the failure mode is a till that
 * decides it is a browser and refuses to open its database.
 *
 * It is also safe during server-side rendering — `isTauri()` returns false when there is no
 * window at all — which matters because the web application shares packages with this one
 * and must never execute desktop-only database code while rendering on a server.
 */

import { isTauri } from '@tauri-apps/api/core';

/** True only inside the Tauri WebView. False in a browser, and false during SSR. */
export function isDesktop(): boolean {
  try {
    return isTauri();
  } catch {
    // Reached when the module loads outside a WebView in an environment where even the
    // check throws. Not a desktop, which is all the caller needs to know.
    return false;
  }
}
