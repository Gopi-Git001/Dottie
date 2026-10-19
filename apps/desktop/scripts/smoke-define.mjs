/** Shared with scripts/build.mjs. The value is a JS expression, not a string literal. */
export const smokeDefine = (production) => ({ __DOTTIE_SMOKE__: production ? 'false' : 'true' });

/** Identifiers that must not survive into the production main bundle. */
export const SMOKE_BUNDLE_MARKERS = ['dottie-smoke', 'nudgeForSmokeTest', 'hideForSmokeTest', 'smokeBody', '__DOTTIE_SMOKE__'];
