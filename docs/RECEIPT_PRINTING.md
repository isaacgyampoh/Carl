# Receipt printing

## Status

| Layer                              | Status                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Receipt content (`renderReceipt`)  | ✅ Implemented and tested — `@carl/domain`                                      |
| Stored for reprint on the terminal | ✅ Implemented — `local_receipts`, written with the sale                        |
| Rendered on screen                 | ✅ Web receipt dialog                                                           |
| ESC/POS encoding                   | ✅ Implemented — `@carl/domain/hardware/escpos`                                 |
| Printer transport (Windows)        | ✅ Implemented — Win32 print spooler, RAW                                       |
| Cash drawer kick                   | ✅ Implemented — ESC/POS pulse through the same transport                       |
| Choosing the printer               | ✅ Implemented — status bar → Printer, saved per machine                        |
| **Tested on a thermal printer**    | ⬜ **NOT TESTED** — no printer or drawer has ever been connected to this system |

The last row is the one that matters most, and it is deliberately not softened. Every layer
above it is verified by automated tests and by a compiler; none of them can tell you that
paper came out of a printer on a shop counter. That takes the printer.

Windows only. `print_raw` on any other platform returns an error saying so, which is why
the macOS build is a compile check and not a release.

## The architecture

```
Complete sale
     │
     ▼  (the sale is on disk BEFORE anything below runs)
ReceiptData            ← assembled from the cart and the sale, in @carl/domain
     │
     ▼
renderReceipt()        ← plain text, 32 or 42 columns
     │
     ├──────────────► local_receipts        (reprint, works offline)
     ├──────────────► screen / share        (web)
     └──────────────► receiptCommands()     (ESC/POS bytes)
                             │
                             ▼
                      print_raw             (Tauri command → Win32 spooler, RAW)
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

## Why the spooler, and not a USB library

A shop buys whatever thermal printer the local supplier had that week and installs it with
the vendor's Windows driver, like any other printer. Once that is done the spooler will
hand raw bytes straight to the device — no vendor SDK, no USB permissions, no per-model
code.

Talking to the USB endpoint directly would mean claiming the interface away from the driver
the shop already installed, and reimplementing per-model quirks nobody on this project can
test. Network (port 9100) printers are a reasonable future addition; they are not what
shops on this target are buying.

The job is submitted with datatype `RAW` so Windows passes the bytes through instead of
rendering them as a document. Without it a customer receives several pages of escape codes.

## Permissions

**No new Tauri capability was needed.** Printing is implemented as ordinary application
commands — `list_printers` and `print_raw` — which are the app's own IPC rather than plugin
permissions. The grant list is unchanged: `core:default`, `dialog:allow-save` and the four
`sql:` permissions. No filesystem, no shell, no process spawning, no HTTP, no USB.

`apps/desktop/src/lib/hardware-security.test.ts` pins that exact set and fails if `fs:`,
`shell:`, `process:`, `http:` or `os:` ever appears.

## Failure is not allowed to cost a sale

Printing happens strictly after the sale is written and strictly outside the code that
decides whether the sale succeeded. A paper jam, an unplugged printer, or no printer at all
cannot roll back money that has already changed hands. The cashier sees a warning that says
the sale is saved and the receipt can be reprinted; the receipt is already in
`local_receipts`.

The drawer fires only for cash. A drawer that springs open on every card payment is a
security problem in a busy shop.

## What "success" means, exactly

`print_raw` returning `Ok` means **the spooler accepted the job**. It does not mean paper
came out — the spooler does not report that — and for a drawer kick it means even less,
since a solenoid reports nothing at all.

Every message in the interface therefore says _sent to the printer_, never _printed_. This
is not pedantry: a cashier who is told a receipt printed, and believes it, will not check
the roll.

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

## Setting a printer up in a shop

1. Install the printer with the manufacturer's Windows driver and confirm Windows' own test
   page prints. If that fails, nothing Carl does will help.
2. In Carl, use **Printer** in the status bar and pick it from the list.
3. Press **Test print**. This is the only honest confirmation that the right physical device
   was chosen — Windows will happily accept a job for a printer in the back office.
4. For a drawer wired to the printer's RJ11 port, press **Test drawer**.

The choice is stored per machine, so each till is set up once.

## Acceptance test, when hardware is available

Not yet performed. It should cover: a cash sale prints and opens the drawer; a card sale
prints and does **not** open the drawer; a sale completes and stays saved with the printer
switched off; the receipt reprints afterwards; and an offline sale prints the
`** NOT YET SYNCED **` marker.
