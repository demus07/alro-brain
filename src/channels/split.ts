export const MAX_LENGTH = 3800;

/** Messaging apps cap message length; split on paragraph or line breaks where possible. */
export function splitMessage(text: string, max = MAX_LENGTH): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf("\n\n", max), rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max));
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
