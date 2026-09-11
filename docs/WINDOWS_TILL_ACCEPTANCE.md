# Accepting a Windows till

Everything in this list needs a real Windows machine, a real printer, a real scanner and a real
shop's data. None of it can be proved in CI, and none of it has been: the build is verified
automatically, the installer is downloaded and checked, and there it stops.

Run this once on the first till at each new client, and again whenever the hardware changes.
Write the date and the machine down. An unticked line is a line nobody has tested.

## Before you start

- The business is onboarded and its owner has signed in at least once on any device.
- You have the business's address (`https://…/<slug>`), a terminal registered in the portal,
  and its activation code (shown once).
- The printer and scanner are connected and switched on **before** the first launch.

## Install

| #   | Step                                                                             | Expected                                                                         | Pass |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---- |
| 1   | Download the installer from the client portal → Windows POS                      | The file is `Carl-POS-Windows-x64-Setup.exe`                                     | ☐    |
| 2   | Check the download against `SHA256SUMS.txt` (`certutil -hashfile <file> SHA256`) | The hashes match                                                                 | ☐    |
| 3   | Run it                                                                           | SmartScreen warns; _More info_ → _Run anyway_ proceeds (expected while unsigned) | ☐    |
| 4   | Finish setup on a machine with no internet                                       | WebView2 installs from the bundle, no download needed                            | ☐    |
| 5   | Launch Carl POS                                                                  | Opens in its own window, no browser bar                                          | ☐    |

## Activation and sign-in

| #   | Step                                     | Expected                                         | Pass |
| --- | ---------------------------------------- | ------------------------------------------------ | ---- |
| 6   | Enter the activation code                | The till is bound to the business and its branch | ☐    |
| 7   | Try the same code on a second machine    | Refused: a code is used once                     | ☐    |
| 8   | Sign a cashier in with their PIN         | The till opens on their name                     | ☐    |
| 9   | Sign in with a PIN from another business | Refused                                          | ☐    |
| 10  | Restart Windows, open Carl POS           | Still activated; only the PIN is asked for       | ☐    |

## Selling

| #   | Step                                          | Expected                                                               | Pass |
| --- | --------------------------------------------- | ---------------------------------------------------------------------- | ---- |
| 11  | Scan a barcoded product                       | The line is added without touching the keyboard                        | ☐    |
| 12  | Scan the same item five times                 | Quantity five, not five lines (or five lines, if that is your setting) | ☐    |
| 13  | Sell a loose-weight item by typing a quantity | Accepted with decimals                                                 | ☐    |
| 14  | Take cash, give change                        | Change shown large enough to read across a counter                     | ☐    |
| 15  | Take mobile money, then a split payment       | Both recorded; the receipt shows each                                  | ☐    |
| 16  | Print the receipt                             | Prints on the roll: business name, items, totals, payment method       | ☐    |
| 17  | Check the printed characters                  | The cedi sign and any accented names print correctly                   | ☐    |
| 18  | Open the cash drawer on a cash sale           | The drawer opens                                                       | ☐    |
| 19  | Refund a line from a past sale                | Stock returns, refund shows on the day report                          | ☐    |

## Offline — the reason a Windows till exists

| #   | Step                                                              | Expected                                            | Pass |
| --- | ----------------------------------------------------------------- | --------------------------------------------------- | ---- |
| 20  | Pull out the network cable (or turn off Wi-Fi)                    | The till says it is offline and keeps selling       | ☐    |
| 21  | Make five sales offline, including one refund                     | Each prints, each marked as not yet sent            | ☐    |
| 22  | Close Carl POS, reopen it, still offline                          | The queued sales are still there                    | ☐    |
| 23  | Restart Windows, still offline                                    | Still there                                         | ☐    |
| 24  | Reconnect                                                         | The five sales sync within a minute, exactly once   | ☐    |
| 25  | Check the portal on another device                                | The same five sales, the same totals, no duplicates | ☐    |
| 26  | Sell offline for longer than the grace window (7 days by default) | The till stops selling and says why                 | ☐    |

## Day end

| #   | Step                                     | Expected                                                    | Pass |
| --- | ---------------------------------------- | ----------------------------------------------------------- | ---- |
| 27  | Count the drawer and close the session   | Expected and counted cash agree, or the difference is shown | ☐    |
| 28  | Open Reports → Day report on the portal  | The till's sales, payments and drawer appear                | ☐    |
| 29  | Print the day report                     | Fits the page; navigation is not printed                    | ☐    |
| 30  | Export sales to CSV and open it in Excel | Columns line up; the cedi sign is not mojibake              | ☐    |

## What to record

For each failure: the step number, what happened, the machine (Windows version, printer model,
scanner model), and whether it repeats. A failure that repeats on one printer model and not
another is a driver question; a failure that repeats everywhere is ours.
