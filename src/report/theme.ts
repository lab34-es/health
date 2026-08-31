import type { Theme } from './model.js';

/** The report's colour tokens — the only place hex values live. */
export const THEME: Theme = {
  palette: {
    background: '#E9E7E4',
    surface: '#F3F2F2',
    surface_raised: '#FFFFFF',
    surface_sunken: '#EEEBE7',
    border: '#D8D5D1',
    border_soft: '#EEEBE7',
    text: '#201F1D',
    text_strong: '#2D2B2B',
    text_muted: '#9B9797',
    text_faint: '#C9C6C2',
    accent: '#B68235',
    accent_soft: '#EFE4D2',
    accent_deep: '#7A5A26',
  },
  indicator: {
    ok: '#3E7C4F',
    warning: '#B68235',
    problem: '#B3402F',
    neutral: '#C9C6C2',
  },
  direction: {
    better: '#3E7C4F',
    worse: '#B3402F',
    flat: '#C9C6C2',
  },
  named: {
    green: '#3E7C4F',
    yellow: '#B68235',
    red: '#B3402F',
    grey: '#C9C6C2',
  },
  // Replaced per report with the colours for that run's configured lanes.
  lanes: {},
};

/** Lane colours for the conventional workflow, matching the report's design. */
const KNOWN_LANES: Record<string, string> = {
  'to do': '#C9C6C2',
  backlog: '#C9C6C2',
  'in progress': '#B68235',
  'code review': '#8E6A2C',
  review: '#8E6A2C',
  qa: '#6E7F5C',
  testing: '#6E7F5C',
  done: '#3E7C4F',
  closed: '#3E7C4F',
};

function mix(from: string, to: string, t: number): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  const out = [0, 2, 4].map((offset) => {
    const a = channel(from.slice(1), offset);
    const b = channel(to.slice(1), offset);
    return Math.round(a + (b - a) * t).toString(16).padStart(2, '0');
  });
  return `#${out.join('')}`.toUpperCase();
}

/**
 * Assigns a colour to each timeline lane.
 *
 * Conventional lane names keep the hand-picked colours from the report's
 * design; anything else is placed on a gold-to-green ramp by position, so a
 * team with its own board still gets a legible left-to-right progression.
 */
export function laneColors(statuses: string[]): Record<string, string> {
  const out: Record<string, string> = {};

  statuses.forEach((status, index) => {
    const known = KNOWN_LANES[status.trim().toLowerCase()];
    if (known) {
      out[status] = known;
      return;
    }
    if (index === 0) {
      out[status] = THEME.indicator.neutral;
      return;
    }
    const steps = Math.max(1, statuses.length - 2);
    out[status] = mix(THEME.indicator.warning, THEME.indicator.ok, Math.min(1, (index - 1) / steps));
  });

  return out;
}
