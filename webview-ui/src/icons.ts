/**
 * Inline SVG icon set. Returned as strings so they can be dropped straight into
 * `innerHTML`. `currentColor` lets each icon inherit the surrounding text color,
 * which keeps everything theme-aware. No external assets (CSP forbids them).
 */

const svg = (body: string, size = 16): string =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
  `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

const stroke = (d: string): string =>
  `<path d="${d}" stroke="currentColor" stroke-width="1.8" ` +
  `stroke-linecap="round" stroke-linejoin="round"/>`;

/** The one colour the theme does not get to override: it identifies the product. */
const BRAND = '#D97757';

const brandStroke = (d: string, width: number): string =>
  `<path d="${d}" stroke="${BRAND}" stroke-width="${width}" ` +
  `stroke-linecap="round" stroke-linejoin="round"/>`;

/** Brand mark: code brackets around a checkmark. Kept in step with media/icon.svg. */
export const logo = (size = 28): string =>
  svg(
    brandStroke('M9 6L4 12L9 18', 1.9) +
      brandStroke('M15 6L20 12L15 18', 1.9) +
      brandStroke('M9 11.8L11 13.8L14.5 9.8', 2),
    size,
  );

export const send = (): string => svg(stroke('M4 12h15M13 6l6 6-6 6'));

export const stop = (): string =>
  svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>');

export const copy = (): string =>
  svg(
    '<rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    14,
  );

export const check = (): string => svg(stroke('M5 12.5l4.5 4.5L19 6'), 14);

export const cross = (): string => svg(stroke('M6 6l12 12M18 6L6 18'), 14);

export const deny = (): string =>
  svg(
    '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/>' +
      stroke('M7 7l10 10'),
    14,
  );

export const chevron = (): string => svg(stroke('M9 6l6 6-6 6'), 14);

export const caretDown = (): string => svg(stroke('M6 9l6 6 6-6'), 12);

export const plus = (): string => svg(stroke('M12 5v14M5 12h14'), 14);

/** Rounded square with a slash inside — the "actions & commands" button. */
export const slashSquare = (size = 15): string =>
  svg(
    '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5" stroke="currentColor" stroke-width="1.8"/>' +
      stroke('M14.5 8l-5 8'),
    size,
  );

/** Lightning bolt — the "Auto mode" glyph. */
export const bolt = (size = 14): string =>
  svg('<path d="M13 2 5 13h5l-1 9 8-11h-5l1-9z" fill="currentColor"/>', size);

/** Raised hand — the "Manual" mode glyph. */
export const hand = (size = 14): string =>
  svg(
    stroke(
      'M8 11.5V6a1.4 1.4 0 0 1 2.8 0v4.5M10.8 10.5V4.8a1.4 1.4 0 0 1 2.8 0v5.7' +
        'M13.6 10.8V6.5a1.4 1.4 0 0 1 2.8 0v7c0 3.4-2.3 6-5.7 6-1.9 0-3.3-.8-4.4-2.3l-2.1-3c-.5-.8-.2-1.7.7-2 .6-.2 1.3 0 1.7.5L8 16.5',
    ),
    size,
  );

/** Upload-from-computer glyph: a tray with an up arrow. */
export const upload = (size = 15): string =>
  svg(stroke('M12 15V4M8 8l4-4 4 4') + stroke('M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3'), size);

/** New-chat glyph: a chat bubble with a plus inside (matches Claude Code). */
export const chatPlus = (size = 17): string =>
  svg(
    stroke(
      'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7' +
        'a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z',
    ) + stroke('M12 8.4v6.2M8.9 11.5h6.2'),
    size,
  );

export const file = (): string =>
  svg(
    stroke('M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z') +
      stroke('M13 3v6h6'),
    14,
  );

export const close = (): string => svg(stroke('M6 6l12 12M18 6L6 18'), 12);

export const clock = (size = 14): string =>
  svg(
    '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/>' +
      stroke('M12 7.5V12l3 2'),
    size,
  );

export const sparkle = (): string =>
  svg(stroke('M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z'), 14);

// -- tool glyphs (native-extension style row icons) -------------------------

export const terminal = (): string =>
  svg(
    '<rect x="3" y="4.5" width="18" height="15" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
      stroke('M7 9.5l2.6 2.5L7 14.5') +
      '<path d="M12.5 14.5H17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    14,
  );

export const search = (): string =>
  svg(
    '<circle cx="11" cy="11" r="6" stroke="currentColor" stroke-width="1.8"/>' +
      stroke('M20 20l-4-4'),
    14,
  );

export const pencil = (): string =>
  svg(stroke('M4 20h4L19 9l-4-4L4 16v4z') + stroke('M14 6l4 4'), 14);

export const globe = (): string =>
  svg(
    '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M3.5 12h17M12 3.5c2.6 2.3 2.6 14.7 0 17M12 3.5c-2.6 2.3-2.6 14.7 0 17" stroke="currentColor" stroke-width="1.6"/>',
    14,
  );

export const code = (): string => svg(stroke('M9 8l-4 4 4 4M15 8l4 4-4 4'), 14);

export const list = (): string =>
  svg(
    '<path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    14,
  );
