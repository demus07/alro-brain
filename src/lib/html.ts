/** Makes text safe to place in HTML (an email body, an attribute). */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Keeps text on one line, for an email subject: no header can be smuggled in after a line break. */
export const oneLine = (s: string) => s.replace(/[\r\n\p{Zl}\p{Zp}]+/gu, " ").trim();
