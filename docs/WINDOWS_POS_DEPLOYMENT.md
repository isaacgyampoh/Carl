# Deploying Carl on a Windows POS machine

What a shop receives, what happens when they run it, and — just as importantly — what has
never been tested.

## What has and has not been verified

|                                              | Status                                                  |
| -------------------------------------------- | ------------------------------------------------------- |
| Windows installer builds on a Windows runner | ✅ Verified in CI                                       |
| Installer is a valid executable, checksummed | ✅ Verified in CI                                       |
| No secret in the installer or bundle         | ✅ Verified against real secret values                  |
| Barcode scanner logic                        | ✅ 15 automated tests                                   |
| Receipt layout and ESC/POS commands          | ✅ 42 automated tests                                   |
| Printer transport compiles for Windows       | ✅ Verified in CI on a Windows runner                   |
| Printing grants no new Tauri capability      | ✅ Asserted by test                                     |
| Offline queue, sync, idempotency             | ✅ Automated tests                                      |
| **Installed on a Windows machine**           | ❌ **Never**                                            |
| **A cashier completing a sale on a till**    | ❌ **Never**                                            |
| **Any thermal printer**                      | ❌ **Never — no printer exists**                        |
| **Any barcode scanner**                      | ❌ **Never — no scanner exists**                        |
| **Any cash drawer**                          | ❌ **Never — no drawer exists**                         |
| Code signing                                 | ⛔ **BLOCKED — no certificate** (see `CODE_SIGNING.md`) |

Nobody on this project owns a Windows machine or any POS peripheral. Everything above
marked ❌ is genuinely unknown, not merely unrecorded.

## Accepting a till on real hardware

Printers, scanners, drawers and a genuine loss of connection cannot be proved in CI, and have
not been. `WINDOWS_TILL_ACCEPTANCE.md` is the checklist to run on the first till at each client,
and again whenever the hardware changes.

## How a client installs it

Everything starts in the client's own portal, under **Windows POS** (owners and anyone with
`devices.manage`):

1. **Download.** The portal links the installer from the latest published GitHub Release,
   resolved on the server. With nothing published it shows no button, never a dead link.
2. **Add the till.** Choose the branch and a name. `register_device` creates the terminal in
   _that_ business and the portal shows a one-time 12-character activation code (24 hours).
3. **On the till.** Run the installer, open Carl POS, type the code. `activate_device` binds
   this machine to the terminal; the business and branch come from the server, never from
   the till. The catalogue downloads and the device secret goes to Windows Credential Manager.
4. **Sign in and sell.** Each cashier uses their own staff PIN. Sales are written to disk
   first and synced when the connection allows; offline, the till keeps selling for the
   device's offline window (7 days by default).

A till serves exactly one business. Re-activating it for another business wipes the previous
business's local data, and is refused while any sale has not reached Carl. A till can record
sales only at its own branch.

## Releasing a new version

Push a `v*` tag. `windows-release.yml` builds the installer on a Windows runner, refuses to
build without the Supabase settings a till needs to sign cashiers in, checksums it, and
publishes the GitHub Release. Every client portal shows it within ten minutes.

## What the shop receives

```
Carl-POS-Windows-x64-Setup.exe    the installer
SHA256SUMS.txt                    to confirm the download arrived intact
```

Built by `.github/workflows/windows-release.yml` on a Windows runner and attached to a
draft GitHub Release when a `v*` tag is pushed.

**The installer is unsigned.** Windows SmartScreen shows "Windows protected your PC" on
first run; the shop must click _More info_ → _Run anyway_. This is not a defect to hide —
it is what an unsigned installer does, and it stops when a certificate is bought.

## Requirements

- Windows 10 version 1809 or later, 64-bit
- Administrator rights to install (the install is per-machine)
- **No internet needed to install**
- No Chrome, no Edge, no Node, no Rust, no developer tooling

## WebView2

Carl draws its interface with WebView2, the rendering engine already inside Windows.

`webviewInstallMode` is `offlineInstaller`, so the runtime travels **inside** the installer.
The alternative — the default bootstrapper — downloads it during installation, which fails
on a shop counter with poor connectivity and reports it as a WebView2 error that means
nothing to a shopkeeper.

- **Already present** (all Windows 11, recent Windows 10): the embedded copy is ignored and
  installation is quick.
- **Missing**: the installer installs it without asking and without a connection.

The cost is size: the CI artifact carrying both the `.exe` and the `.msi` is about **504 MB**
(measured, run 34502546417). That is a large download once, and a non-issue on a USB stick.

`fixedVersion` was rejected: pinning a runtime would make browser-engine security updates
our responsibility, which is a worse job than we are equipped to do.

## First launch

1. Desktop shortcut, or Start menu under **Carl POS**
2. Carl opens as an application — no browser window, no address bar, no tabs
3. **Activation**, once per machine: the platform owner issues an activation code and reads
   it out. The till binds itself to that shop and branch.
4. **PIN**: the cashier types four digits. The till already knows the shop, so nothing else
   is asked.
5. The shop and branch are shown above the PIN boxes — a till activated against the wrong
   counter is otherwise invisible until the takings land in the wrong place.

## Network

|                         | Needs the internet   |
| ----------------------- | -------------------- |
| Installing              | No                   |
| Activating the terminal | **Yes**, once        |
| Signing in              | **Yes**              |
| Selling                 | No                   |
| Syncing sales           | Yes, when it returns |

A cashier signs in at the start of a shift. Selling continues if the connection drops
afterwards.

## Offline

Sales are written to a local SQLite database before the cashier is told they succeeded, and
sync when the connection returns. Each carries an idempotency key, so a sale that syncs
twice is recorded once.

**This has passed automated testing and has never run on a POS machine.** Physical
verification — pulling the network cable mid-shift — remains outstanding.

## Receipt printers

Carl sends receipts to a printer through the Windows print spooler.

- ✅ Receipt layout, 32 and 42 column
- ✅ ESC/POS: initialise, align, cut, drawer pulse, ASCII transliteration
- ✅ Transport — Win32 spooler, submitted as a `RAW` job
- ❌ **Never tested on a physical printer** — none has been connected to this project

Install the printer with the manufacturer's Windows driver first and confirm Windows' own
test page prints. Then, in Carl, use **Printer** in the status bar, pick it from the list,
and press **Test print**. The choice is stored on that machine. A drawer on the printer's
RJ11 port is confirmed with **Test drawer**.

The spooler is used rather than USB because the shop has already installed a driver, and
claiming the USB interface would take the device away from it.

No printer model is _supported_, because none has been tested. The transport is
model-independent by design — it is the same path Windows uses for any RAW job — but do not
tell a client a particular printer is known to work until one has.

A successful send means the spooler accepted the job. It does not mean paper came out. The
interface says "sent to the printer" for that reason.

### Character set

Thermal printers are not Unicode. Text is transliterated before printing, so `GH₵12.50`
prints as `GHC12.50` rather than as a box. Accents are stripped (`Café` → `Cafe`) because a
readable receipt matters more than a faithful one.

## Cash drawers

A POS drawer is a solenoid wired to the printer's RJ11 socket and fired by a printer
command. Carl generates that command (`ESC p`, pin 0 or 1, a short pulse) and sends it down
the same spooler path as a receipt, so the drawer needs no separate connection or driver.

It fires for cash payments only. A drawer that springs open on every card sale is a security
problem in a busy shop.

Like printing, this has never been tried on physical hardware, and a solenoid reports
nothing back even when it has.

The pulse is capped so a solenoid is never asked to hold: an overheated drawer is somebody's
property.

## Barcode scanners

USB and Bluetooth scanners behave as keyboards. Carl assumes nothing else — no vendor SDK.

- Search box holds focus permanently; anything that steals it breaks scanning
- Enter tries a barcode before falling back to a text search
- Terminator characters a scanner appends are tolerated
- A case barcode adds its whole pack, not one unit

Tested in software, never with a scanner.

## Updating

Install the new version over the old one. Local data — pending sales, the catalogue, the
device binding — is kept in the Windows application data folder and survives.

Automatic updates are configured but **inactive**: enabling them needs a signing key, and an
unsigned update channel is a way to install anything on a shop's till.

## Troubleshooting

**"Windows protected your PC"** — expected. The installer is unsigned. _More info_ → _Run
anyway_. Verify the SHA256 first if the file did not come directly from us.

**Carl opens on the activation screen again after working** — the device secret is gone from
the Windows credential store, usually a reimaged machine or a new Windows user. Issue a new
activation code.

**"This terminal is not activated"** at the PIN screen** — same cause.

**Sales are not appearing on the web** — check the sync indicator. Carl keeps them locally
and retries; they are not lost. If it says a sale needs attention, that sale hit a rule the
server refused, and somebody has to look at it.

**Nothing prints** — check, in order: that Windows' own test page prints; that a printer is
selected under **Printer** in the status bar; and that **Test print** reports it was sent.
If Carl says the receipt was sent and no paper appears, the job reached the spooler and the
problem is between the spooler and the device — the Windows print queue will say more.

Sales are never lost to a printing failure. Carl saves the sale first and the receipt can be
reprinted.
