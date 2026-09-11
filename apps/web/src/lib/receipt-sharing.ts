/**
 * Sending a customer their receipt, through the shop's own phone.
 *
 * Carl sends nothing itself: there is no gateway to pay for, no customer number kept for the
 * purpose, and no message that can leave without the cashier seeing it. This only prepares what
 * WhatsApp or the messaging app is handed.
 *
 * Pure, and outside the component, so the number handling can be tested on its own.
 */

/**
 * A phone number in the form WhatsApp expects: digits, with a country code.
 *
 * Ghanaian numbers are written 024 xxx xxxx locally and +233 24 xxx xxxx internationally, and
 * shops type both. Anything that reads as neither returns null rather than being guessed at: a
 * receipt sent to the wrong person is worse than one not sent at all.
 */
export function whatsappNumber(
  phone: string | null | undefined,
  countryCode = '233',
): string | null {
  const digits = (phone ?? '').replace(/[^\d+]/g, '');
  if (digits.length === 0) return null;
  if (digits.startsWith('+')) return /^\+\d{8,15}$/.test(digits) ? digits.slice(1) : null;
  // A local number: the leading zero stands in for the country code.
  if (/^0\d{8,12}$/.test(digits)) return `${countryCode}${digits.slice(1)}`;
  if (/^\d{8,15}$/.test(digits)) return digits;
  return null;
}
