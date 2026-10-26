import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFetch } from '../src/provider-fetch.js';

test('provider transport bypasses Vinext cache and preserves Workers receiver', async () => {
 const key = Symbol.for('vinext.fetchCache.originalFetch');
 const globals = globalThis as unknown as Record<symbol, unknown>;
 const prior = globals[key], patched = globalThis.fetch;
 globals[key] = async function(this: typeof globalThis) { assert.equal(this, globalThis); return new Response('native'); };
 globalThis.fetch = (async () => { throw new Error('framework wrapper must not handle health data'); }) as typeof fetch;
 try { assert.equal(await (await providerFetch()('https://example.test')).text(), 'native'); }
 finally { globalThis.fetch = patched; if (prior === undefined) delete globals[key]; else globals[key] = prior; }
});
