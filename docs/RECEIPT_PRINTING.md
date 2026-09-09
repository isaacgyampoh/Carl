# Receipt printing

## Status

| Layer                                     | Status                                                      |
| ----------------------------------------- | ----------------------------------------------------------- |
| Receipt content (`renderReceipt`)         | ✅ **Implemented and tested** — 18 tests in `@carl/domain`   |
| Stored for reprint on the terminal        | ✅ Implemented — `local_receipts`, written with the sale     |
| Rendered on screen                        | ✅ Web receipt dialog                                        |
| ESC/POS encoding                          | ⬜ **Not built**                                             |
| USB / serial / network printer transport  | ⬜ **Not built**                                             |
| Cash drawer kick                          | ⬜ **Not built**                                             |
| Tested on a thermal printer               | ⬜ **Never** — no hardware has been connected                |

Nothing below the first three rows exists. No printer has ever been attached to this
system, and no claim here should be read as saying otherwise.

## The architecture

```
Complete sale
     │
     ▼
ReceiptData            ← assembled from the cart and the sale, in @carl/domain
     │
     ▼
renderReceipt()        ← plain text, 32 or 42 columns
     │
     ├──────────────► local_receipts        (reprint, works offline)
     ├──────────────► screen / share        (implemented on web)
     └──────────────► ESC/POS encoder       ← NOT BUILT
                             │
                             ▼
                      printer transport     ← NOT BUILT
                             │
                             ▼
                      thermal printer
```

## Why the content lives in the domain

A receipt is the customer's copy of a financial record, and in Ghana it is routinely the
only copy either party keeps. What it says has to be exactly what was charged.

Formatting it inside a printer driver would give the web and the desktop two chances to
disagree about a total, and the disagreement would be discovered by a customer holding a
piece of paper. So `renderReceipt` is a pure function in `@carl/domain`, shared by both,
performing no arithmetic of its own beyond laying out figures it is handed.

It emits plain text because that is what a thermal printer consumes, what a WhatsApp
message can carry, and what a test can assert on precisely.

## What the remaining work is

**ESC/POS encoding.** Prepending control codes to the text this already produces: initialise,
select the font, set alignment, cut, and the drawer-kick pulse. The line content does not
change, which is why the content layer was built first.

**Transport.** A Tauri command holding the connection, since a browser cannot open a USB or
serial device. Three cases in practice:

| Connection      | Approach                                                     |
| --------------- | ------------------------------------------------------------ |
| USB             | A Rust command using `rusb`, or the OS spool queue            |
| Network (9100)  | A raw TCP socket from Rust — the simplest and most reliable   |
| Bluetooth       | Serial profile via the OS                                     |

Network printers are the most practical first target: no driver, no permissions dialog, and
the same code path on macOS and Windows.

**Permissions.** Any of these needs a new Tauri capability. The current capability set grants
only SQL and a save dialog — no filesystem, no shell — and a printer transport must extend
that as narrowly as the SQL grant does.

## Offline

A receipt printed before its sale has synced carries:

```
** NOT YET SYNCED **
```

Without it, a shop reconciling the day cannot tell which receipts represent sales the server
has not seen. The receipt is stored in `local_receipts` at the moment the sale is queued, so
a customer returning an hour later can have it reprinted from a terminal that has still
never been online.

Storing the receipt is deliberately allowed to fail without failing the sale: the money has
been taken and the sale is already on disk. A missing reprint is an inconvenience; a lost
sale is not.
