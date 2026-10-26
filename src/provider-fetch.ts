/**
 * Vinext beta.5 keeps its original transport here before patching global fetch.
 * Health and OAuth requests must bypass framework caching, and Workers requires
 * its native fetch receiver. Keep this adapter covered when upgrading Vinext.
 */
export function providerFetch(): typeof fetch {
  const original = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('vinext.fetchCache.originalFetch')];
  return (typeof original === 'function' ? original as typeof fetch : globalThis.fetch).bind(globalThis);
}
