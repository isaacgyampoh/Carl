/*
 * Runs before the application bundle, and exists for the failures the application cannot
 * report because it never started.
 *
 * A till that shows nothing is the worst screen Carl can draw: a cashier has a customer in
 * front of them and no way to tell whether the machine is thinking, broken, or off. Three
 * things can leave the window empty before React is in a position to say anything —
 *
 *   the bundle fails to download,
 *   the bundle fails to parse or throws while its modules are evaluating,
 *   something in the start-up path never settles,
 *
 * — and in all three the boot mark from index.html is still on screen, saying "Starting the
 * till…" forever. This turns that into a sentence somebody can act on.
 *
 * Plain script, no modules, no imports: it has to work in exactly the conditions where the
 * module bundle did not. It is served from the application itself, so `script-src 'self'`
 * allows it where an inline script would be refused. `let` and `const` are fine — Tauri 2
 * requires WebView2 on Windows and WKWebView on macOS, and both are years past ES2015.
 */
(function () {
  'use strict';

  let shown = false;

  /** Null once React has mounted: from that moment the application owns the screen. */
  function mark() {
    return document.getElementById('boot');
  }

  function show(headline, detail) {
    const boot = mark();
    // Already gone means the application started and any error since is its own to report.
    if (shown || !boot) return;
    shown = true;

    const bar = boot.querySelector('.bar');
    if (bar) bar.remove();

    const said = boot.querySelector('.said');
    if (said) said.textContent = headline;

    if (detail) {
      const line = document.createElement('p');
      line.style.cssText =
        'max-width:520px;margin:0;color:#9aa4b2;font-size:14px;line-height:1.5;' +
        'word-break:break-word';
      line.textContent = detail;
      boot.appendChild(line);
    }

    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = 'Start again';
    again.style.cssText =
      'margin-top:8px;padding:12px 22px;font-size:16px;border-radius:8px;border:0;' +
      'background:#3d7dfa;color:#fff;cursor:pointer';
    again.addEventListener('click', function () {
      window.location.reload();
    });
    boot.appendChild(again);
  }

  /*
   * Capture phase, and that is the whole point of the third argument.
   *
   * A <script> or stylesheet that fails to download fires an error event on the element,
   * and that event does not bubble. A plain window listener never sees it, which is how the
   * "bundle never downloaded" case sat on "Starting the till…" for twenty-five seconds
   * before the timer below noticed. Listening on the way down catches it as it happens.
   */
  window.addEventListener(
    'error',
    function (event) {
      // A failed <script> or stylesheet arrives here as an event with a target rather than a
      // message, and is the "bundle never downloaded" case.
      const detail =
        event.message ||
        (event.target && event.target.src
          ? 'Could not load ' + String(event.target.src)
          : 'Unknown error');
      show('Carl could not start.', detail);
    },
    true,
  );

  window.addEventListener('unhandledrejection', function (event) {
    const reason = event.reason;
    show(
      'Carl could not start.',
      (reason && (reason.message || String(reason))) || 'Unknown error',
    );
  });

  // Nothing threw, nothing loaded, nothing moved. The application's own watchdog covers the
  // case where it did start, so this only ever fires when React never mounted at all.
  window.setTimeout(function () {
    show(
      'Carl is taking longer than usual to start.',
      'The application has not finished loading. Starting again is safe: nothing is written ' +
        'down until a sale is rung up.',
    );
  }, 25000);
})();
