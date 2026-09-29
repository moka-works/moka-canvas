import { PageTopBar } from "../../editor/panels/PageTopBar";

interface AssetsTopBarProps {
  /** Going home from the files room, which puts the project down first. */
  onHome: () => void;
}

/**
 * The files room's bar: the shared one, with nothing of its own in the middle
 * and nothing to put under the Export button.
 *
 * A file is not a document the bar acts on as a whole — the room's questions
 * are the column's (which files) and the stage's (which one) — so the bar
 * carries only what every working page carries and the way home. Nothing
 * leaves the project from here either, so the export button stands where every
 * page wears it, grayed and saying as much on its tooltip.
 */
export function AssetsTopBar({ onHome }: AssetsTopBarProps) {
  return <PageTopBar current="assets" onHome={onHome} />;
}
