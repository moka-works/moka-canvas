/**
 * The marks a room's rail speaks in.
 *
 * Drawn in the same hand as the cutting room's own marks — a 24 box, one and a
 * half strokes, round ends — so a rail of drawers reads as one set wherever it
 * stands.
 */

interface IconProps {
  size?: number;
}

/** Two frames side by side: the boards a project holds. */
export function CanvasesIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <rect height="12.5" rx="1.8" width="12" x="3.5" y="4.5" />
      <path d="M18.5 8.5v9.2c0 .7-.6 1.3-1.3 1.3H8" />
    </svg>
  );
}

/** A stack of sheets: the files a project is made of. */
export function AssetsIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M12 3.6 20.5 8 12 12.4 3.5 8 12 3.6Z" />
      <path d="m4.8 12 7.2 3.7 7.2-3.7" />
      <path d="m4.8 16 7.2 3.7 7.2-3.7" />
    </svg>
  );
}

/** A book open on a line or two: the stories a project tells. */
export function StoriesIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M12 6.2c-1.7-1.2-3.9-1.6-6.2-1.5-.6 0-1 .4-1 1v10.6c0 .6.4 1 1 1 2.3-.1 4.5.3 6.2 1.5" />
      <path d="M12 6.2c1.7-1.2 3.9-1.6 6.2-1.5.6 0 1 .4 1 1v10.6c0 .6-.4 1-1 1-2.3-.1-4.5.3-6.2 1.5" />
      <path d="M12 6.2v12.6" />
    </svg>
  );
}

/** Stairs of numbers: the steps a telling is walked in. */
export function StepsIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4.5 18.5h4v-4.5h4V9.5h4V5h3" />
    </svg>
  );
}
