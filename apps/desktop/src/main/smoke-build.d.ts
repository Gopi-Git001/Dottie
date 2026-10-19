/**
 * esbuild `define` for the main bundle (scripts/build.mjs).
 * `true` in the dev/smoke bundle, `false` in the production bundle, where the
 * smoke path is dead-code-eliminated. Not a runtime global.
 */
declare const __DOTTIE_SMOKE__: boolean;
