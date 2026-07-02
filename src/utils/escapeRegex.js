/** Escape user input before using in RegExp to reduce ReDoS / broad scans. */
export function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
