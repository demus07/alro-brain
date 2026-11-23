/**
 * A phone number as WhatsApp wants it: digits only, with the country code. A number typed without one
 * ("98200 12345", "098200 12345") gets ALRO_DEFAULT_COUNTRY_CODE (91, India, unless set otherwise).
 * Undefined when what was typed can't be a phone number.
 */
export function normalizePhone(raw: string | null | undefined, country = process.env.ALRO_DEFAULT_COUNTRY_CODE ?? "91"): string | undefined {
  if (!raw) return undefined;
  const plus = raw.trim().startsWith("+") || raw.trim().startsWith("00");
  let digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("00")) digits = digits.slice(2);
  if (!plus) {
    digits = digits.replace(/^0+/, "");
    if (digits.length <= 10) digits = `${country}${digits}`;
  }
  return digits.length >= 10 && digits.length <= 15 ? digits : undefined;
}
