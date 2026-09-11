import type { ReactNode } from 'react';

/**
 * The screens someone meets before they are signed in: the owner's PIN, a business's door, a
 * till's door, the till finder, the email sign-in.
 *
 * They used to be a form on a white page. That is not wrong, but it is the first thing a
 * shopkeeper sees of software they are paying for, and the first thing their customers see over
 * the counter — so it should look like a product rather than a blank tab.
 *
 * ## Why this is drawn rather than photographed
 *
 * No image file. The backdrop is two soft washes of the brand colours over a faint grid, drawn
 * by the browser: nothing to download on a shop's connection, nothing to go stale in a cache,
 * and nothing that looks wrong on a cheap tablet's screen. A till that opens in a market with
 * one bar of signal should not be waiting on a photograph.
 *
 * ## Why the card is solid
 *
 * Decoration stays behind glass. Every word — a PIN prompt, an error, a business's name — sits
 * on plain surface colour at full contrast, so nothing a cashier must read is competing with a
 * gradient.
 */
export function DoorScreen({
  children,
  footer,
  wide = false,
}: {
  children: ReactNode;
  /** Quiet text under the card: who this screen is for, or where else to go. */
  footer?: ReactNode;
  /** For the few doors that hold more than a PIN pad. */
  wide?: boolean;
}) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-5 py-10">
      <DoorBackdrop />
      <div className={`relative w-full ${wide ? 'max-w-md' : 'max-w-sm'}`}>
        <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-6 shadow-[0_24px_70px_-30px_oklch(0.21_0.015_255/0.45)] sm:p-8">
          {children}
        </div>
        {footer && (
          <div className="mt-6 text-center text-xs text-[color:var(--color-ink-muted)]">
            {footer}
          </div>
        )}
      </div>
    </main>
  );
}

/** Decoration, and nothing else: hidden from screen readers, and it cannot be clicked through. */
function DoorBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 bg-[color:var(--color-canvas)]"
    >
      {/*
       * Two washes of colour, placed off-canvas so their soft edges fall across the screen
       * rather than showing as circles. Brand at the top, the colour of a completed sale at the
       * bottom.
       */}
      <div className="absolute -left-40 -top-48 size-[34rem] rounded-full bg-[color:var(--color-brand)] opacity-[0.16] blur-[90px]" />
      <div className="absolute -bottom-56 -right-32 size-[30rem] rounded-full bg-[color:var(--color-positive)] opacity-[0.12] blur-[90px]" />
      {/* Graph paper, faint enough to read as texture rather than as lines. */}
      <div
        className="absolute inset-0 [background-size:34px_34px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_78%)]"
        style={{
          backgroundImage:
            'linear-gradient(to right, color-mix(in oklch, var(--color-ink) 5%, transparent) 1px, transparent 1px),' +
            'linear-gradient(to bottom, color-mix(in oklch, var(--color-ink) 5%, transparent) 1px, transparent 1px)',
        }}
      />
    </div>
  );
}
