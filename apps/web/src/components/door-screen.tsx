import type { ReactNode } from 'react';

/**
 * The screens someone meets before they are signed in: the owner's PIN, a business's door, a
 * till's door, the till finder, the email sign-in.
 *
 * They used to be a form on a white page. That is not wrong, but it is the first thing a
 * shopkeeper sees of software they are paying for, and the first thing their customers see over
 * the counter — so it should look like a product rather than a blank tab.
 *
 * ## The picture behind it
 *
 * A real image file, /door-backdrop.png: a dark, softly lit field in Carl's own colours, drawn
 * by scripts/generate-door-backdrop.mjs so it can be changed and regenerated rather than
 * sourced. It is 600x400 and about 80 KB, with no edge anywhere in it, so it stretches across a
 * counter screen without showing and costs a shop on a slow connection almost nothing. The
 * colour underneath it is the image's own average, so a till that is still fetching it shows
 * the right screen rather than a white flash.
 *
 * To use a photograph instead — a shop, a counter, a market — replace that one file. Keep it
 * dark and quiet: everything here is read on top of it.
 *
 * ## Why the card is solid
 *
 * Decoration stays behind glass. Every word — a PIN prompt, an error, a business's name — sits
 * on plain surface colour at full contrast, so nothing a cashier must read is competing with a
 * picture. Only the one quiet line under the card sits on the image, in white.
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
        <div className="rounded-2xl bg-[color:var(--color-surface)] p-6 shadow-[0_30px_80px_-24px_rgb(2_8_23/0.75)] sm:p-8">
          {children}
        </div>
        {footer && (
          <div className="mt-6 text-center text-xs text-white/75 [text-shadow:0_1px_2px_rgb(2_8_23/0.45)]">
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
      className="pointer-events-none absolute inset-0 -z-10 bg-[#1f405e] bg-[url('/door-backdrop.png')] bg-cover bg-center"
    >
      {/* Graph paper, faint enough to read as texture rather than as lines. */}
      <div
        className="absolute inset-0 opacity-[0.09] [background-size:34px_34px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_78%)]"
        style={{
          backgroundImage:
            'linear-gradient(to right, white 1px, transparent 1px),' +
            'linear-gradient(to bottom, white 1px, transparent 1px)',
        }}
      />
      {/*
       * A little more dark at the very bottom than the picture has on its own, so the line under
       * the card is read against something settled on every screen shape.
       */}
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-[rgb(2_8_23/0.45)] to-transparent" />
    </div>
  );
}
