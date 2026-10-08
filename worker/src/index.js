// Worker entry. Only the default handler may be exported from this module.
import { handle } from './core.js';

export default {
  async fetch(request, env) {
    return handle(request, env, {
      fetchImpl: fetch,
      cache: typeof caches !== 'undefined' ? caches.default : null,
      now: Math.floor(Date.now() / 1000),
    });
  },
};
