/**
 * The theme, applied before the first paint.
 *
 * Kept in its own server-safe module, deliberately. This string has to be
 * inlined into the document head by the root layout — a server component — and
 * the layout cannot reliably read a plain constant out of a `'use client'`
 * module: in an RSC build those exports are client *references*, not values.
 * It happens to work today because the bundler inlines the literal, which is a
 * bundler detail rather than a guarantee, and if it ever stopped working the
 * symptom would be a white flash on every navigation for every dark-mode user
 * rather than an error anyone would notice in review.
 *
 * So the script lives here, the button lives in ThemeToggle, and they share
 * only the storage key.
 */

export const THEME_STORAGE_KEY = 'ffe-theme';

/*
 * Light unless the reader has asked for dark, rather than whatever the OS says.
 *
 * Following `prefers-color-scheme` sounds respectful and has a real cost here:
 * anyone whose desktop is dark never saw the light design at all, which is not
 * a preference they expressed about this site. The charts are built and checked
 * against the light surface first — the palette was validated for contrast on
 * white — so light is the intended reading of this product, and dark is the
 * deliberate alternative a reader can choose and keep.
 *
 * An explicit choice always wins and is remembered; only the absence of one
 * defaults.
 */
export const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    document.documentElement.dataset.theme = stored === 'dark' ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
`;
