import type { ReactNode } from 'react';

/**
 * The screens someone meets before they are signed in: the owner's PIN, a business's door, a
 * till's door, the till finder, the email sign-in.
 *
 * They used to be a form on a white page. That is not wrong, but it is the first thing a
 * shopkeeper sees of software they are paying for, and the first thing their customers see over
 * the counter — so it should look like a product rather than a blank tab.
 *
 * ## The pictures
 *
 * Two of them, supplied by the owner and prepared for this: the storefront was cut off the paper
 * it was drawn on and set on the same blue field as the other, so the five doors read as one
 * family rather than two designs. The doors that belong to a single business get the shopfront;
 * the owner's own door and the email sign-in get the other.
 *
 * Each comes in two shapes, because one crop cannot serve both a counter screen and a phone:
 *
 * - **wide** (1600x1000) for anything from a laptop up. It is composed with the subject left of
 *   centre, which is why the card moves right on a wide screen — the picture is meant to be
 *   looked at, not hidden behind a PIN pad.
 * - **tall** (1000x1250) for phones and portrait tablets. The whole subject sits in the top two
 *   thirds and the field settles into one flat colour at the bottom edge — the same colour this
 *   component paints underneath — so the picture ends and the page carries on with no seam, and
 *   a phone never shows a meaningless crop of a picture drawn for a laptop.
 *
 * A browser fetches only the one its screen matches, and each is under 50 KB, so a shop pays for
 * its door once on whatever connection it has.
 *
 * The ground under the pictures is #062a86, the colour both tall ones end on, painted on the
 * screen itself: under the picture while it is still arriving, below it once it has, and in
 * place of it if it never comes.
 *
 * ## Why the card is solid
 *
 * Decoration stays behind glass. Every word — a PIN prompt, an error, a business's name — sits
 * on plain surface colour at full contrast, so nothing a cashier must read is competing with a
 * picture. Only the one quiet line under the card sits on the picture, in white, over a scrim
 * dark enough to carry it.
 */
export function DoorScreen({
  children,
  footer,
  wide = false,
  picture = 'commerce',
}: {
  children: ReactNode;
  /** Quiet text under the card: who this screen is for, or where else to go. */
  footer?: ReactNode;
  /** For the few doors that hold more than a PIN pad. */
  wide?: boolean;
  /** A shopfront for the doors that belong to one business; the general one elsewhere. */
  picture?: Picture;
}) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#062a86] px-5 py-10 lg:items-end lg:px-[7vw]">
      <DoorBackdrop picture={picture} />
      <div className={`relative w-full ${wide ? 'max-w-md' : 'max-w-sm'}`}>
        <div className="rounded-2xl bg-[color:var(--color-surface)] p-6 shadow-[0_30px_80px_-24px_rgb(1_16_54/0.8)] sm:p-8">
          {children}
        </div>
        {footer && (
          <div className="mt-6 text-center text-xs text-white/80 [text-shadow:0_1px_3px_rgb(1_16_54/0.6)]">
            {footer}
          </div>
        )}
      </div>
    </main>
  );
}

type Picture = 'commerce' | 'shopfront';

/**
 * Tall first, wide from a laptop up. Written out rather than built from the name because
 * Tailwind reads these files as text: a class it cannot see in the source is a class it does
 * not generate, and the door would come up plain blue.
 */
const PICTURES: Record<Picture, string> = {
  commerce: "bg-[url('/door/commerce-tall.webp')] lg:bg-[url('/door/commerce-wide.webp')]",
  shopfront: "bg-[url('/door/shopfront-tall.webp')] lg:bg-[url('/door/shopfront-wide.webp')]",
};

/** Decoration, and nothing else: hidden from screen readers, and it cannot be clicked through. */
function DoorBackdrop({ picture }: { picture: Picture }) {
  return (
    <div
      aria-hidden
      /*
       * Only the picture. The colour under it is painted by the screen itself rather than here,
       * because this element is a sibling of the text, not an ancestor of it: anything reading
       * the page — a contrast audit, a browser's forced-colours mode — resolves what is behind
       * a word by walking up its ancestors, and would find the white page background and
       * conclude that the white line under the card is invisible.
       */
      className={`pointer-events-none absolute inset-0 -z-10 bg-[#062a86] bg-[length:100%_auto] bg-top bg-no-repeat lg:bg-cover lg:bg-[position:36%_center] ${PICTURES[picture]}`}
    >
      {/*
       * The scrim. On a phone it only settles the bottom, where the quiet line goes; the picture
       * itself is left bright. On a wide screen it darkens the side the card moved to and thins
       * out to nothing over the picture.
       */}
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_45%,rgb(1_16_54/0.45))] lg:bg-[linear-gradient(to_left,rgb(1_16_54/0.86),rgb(1_16_54/0.4)_42%,transparent_72%)]" />
    </div>
  );
}
