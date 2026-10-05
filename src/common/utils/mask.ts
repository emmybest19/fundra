// Masks contact details for places that must record *which* address without storing it in
// full: audit metadata (kept forever) and logs.

/** `emma.okafor@fundra.dev` → `e***@fundra.dev`. Malformed input is masked entirely. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** `+2348012345678` → `+234*******678`: country code and last 3 digits only. */
export function maskPhone(phone: string): string {
  if (!/^\+\d{8,15}$/.test(phone)) return '***';
  const visibleStart = 4; // "+" and up to 3 digits of country code
  return `${phone.slice(0, visibleStart)}${'*'.repeat(phone.length - visibleStart - 3)}${phone.slice(-3)}`;
}
