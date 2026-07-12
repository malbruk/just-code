/**
 * The Just Code brand mark, as an inline SVG string.
 *
 * Geometry and colours are lifted verbatim from `media/icon.svg` — keep the two in
 * step. Unlike `media/activity-icon.svg`, this one is painted normally rather than
 * used as a mask, so it keeps its full colour: coral bubble, white keyline, white
 * wordmark.
 *
 * Three layers, painted back to front. The keyline is not decoration: without it the
 * coral bubble would sit directly on the panel background, and on a light theme its
 * edge all but disappears.
 */

/** The colours the theme does not get to override: they identify the product. */
const CORAL_LIGHT = '#f18e88';
const CORAL = '#e2544e';
const PAPER = '#ffffff';

/** Bubble body: a rounded rect, with the tail hanging off its bottom edge. */
const BODY = 'M22 76 C22 45 45 21 76 21 H179 C210 21 233 45 233 76 V146 C233 177 210 201 179 201 H76 C45 201 22 177 22 146 Z';
const TAIL = 'M90 186 C92 203 99 219 112 232 C119 239 137 239 144 231 C156 217 164 201 166 186 Z';

/** `<Just/>`, drawn as one round-capped stroke — the same weight the source mark uses. */
const WORDMARK = [
  'M51 106 L38 118.5 L51 131',
  'M84 101 V122 C84 132 75 138 67 133',
  'M100 111 V126 C100 132 104 136 109 136 C113 136 117 132 117 126 V111',
  'M117 126 V135',
  'M145 114 C143 111 138 110 134 111.5 C129 113 128 118 132 120.5 C136 123 142 122.5 145 126 C148 129.5 145 134 139.5 135 C135 135.8 131 134 129 131',
  'M162 104 V127 C162 133 166 136 167 135',
  'M157 113 H168',
  'M182 138 L196 101',
  'M208 106 L221 118.5 L208 131',
];

/**
 * A per-instance gradient id. Two marks on the page must not share one: duplicate
 * ids are invalid, and the second `url(#…)` would resolve to the first mark's node.
 */
let seq = 0;

/** Brand mark: the Just Code logo. Kept in step with media/icon.svg. */
export const logo = (size = 28): string => {
  const grad = `jc-bubble-${seq++}`;
  return (
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 256 256" fill="none" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<defs><linearGradient id="${grad}" x1="40" y1="21" x2="216" y2="237" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${CORAL_LIGHT}"/><stop offset="1" stop-color="${CORAL}"/>` +
    `</linearGradient></defs>` +
    // Keyline: the silhouette fattened by a stroke, half of which falls outside the fill.
    `<g fill="${PAPER}" stroke="${PAPER}" stroke-width="24" stroke-linejoin="round">` +
    `<path d="${BODY}"/><path d="${TAIL}"/></g>` +
    // The bubble. Body and tail both cover their shared seam, so no keyline shows through.
    `<g fill="url(#${grad})"><path d="${BODY}"/><path d="${TAIL}"/></g>` +
    `<g fill="none" stroke="${PAPER}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">` +
    WORDMARK.map((d) => `<path d="${d}"/>`).join('') +
    `</g>` +
    `</svg>`
  );
};
