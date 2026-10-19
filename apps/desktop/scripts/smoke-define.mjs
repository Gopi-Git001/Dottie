/** Shared with scripts/build.mjs. The value is a JS expression, not a string literal. */
export const smokeDefine = (production) => ({ __DOTTIE_SMOKE__: production ? 'false' : 'true' });

/** Any of these in the production main bundle means smoke mode survived dead-code elimination. */
const SMOKE_BUNDLE_PATTERN = /ForSmokeTest|smokeBody|smokeApproval|smokeWindowState|markSmokeActive|assertSmokeMode|__DOTTIE_SMOKE__|dottie-smoke/g;

/** @param {string} source @returns {string[]} matched identifiers (empty when the bundle is clean) */
export function smokeMarkerHits(source) {
  return [...new Set(source.match(SMOKE_BUNDLE_PATTERN) ?? [])];
}
