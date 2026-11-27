/**
 * Build flag: true for the self-contained supplementary-material build (scripts/build-supplementary.mjs),
 * which drops project files / imports and loads bundled scenes instead. Set through Vite's `define`.
 */
declare const __SUPPLEMENTARY__: boolean;
