/**
 * The room's own marks.
 *
 * Drawn here rather than taken from a set, the way every page draws the few
 * icons it needs: a book with ruled lines stands for a telling, and the same
 * shape is drawn at two sizes — in the corner menu, and over the empty room.
 */
export function StoryIcon({ size = 16 }: { size?: number }) {
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
      <path d="M4 5.5A2 2 0 0 1 6 3.5h12a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2Z" />
      <path d="M4 17.5h15" />
      <path d="M8 3.5v14M12 3.5v14" />
    </svg>
  );
}

/**
 * The mark a fold wears: it points down while the thing is open and right
 * while it is folded.
 *
 * Drawn rather than set as text: a triangle character is missing from some
 * system fonts, and a fold nobody can see is a fold nobody can press.
 */
export function FoldChevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`story-chevron${open ? "" : " is-folded"}`}
      fill="none"
      height={14}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width={14}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
