import {
  WorkspaceSide,
  type WorkspaceFace,
} from "../../workspace/WorkspaceSide";
import { useClipStore, type ClipFace } from "../stores/clipStore";
import {
  AdjustIcon,
  CutIcon,
  FiltersIcon,
  TextIcon,
} from "../components/ClipIcons";
import { MediaColumn } from "./MediaColumn";

interface RailFace extends WorkspaceFace {
  id: ClipFace;
}

/** The material a cut is made of, above the tools laid over it. */
const GROUPS: readonly (readonly RailFace[])[] = [
  [
    {
      id: "cut",
      label: "clip:rail.cut",
      hint: "clip:rail.cutHint",
      icon: CutIcon,
    },
  ],
  [
    {
      id: "text",
      label: "clip:rail.text",
      hint: "clip:rail.textHint",
      icon: TextIcon,
    },
    {
      id: "filters",
      label: "clip:rail.filters",
      hint: "clip:rail.filtersHint",
      icon: FiltersIcon,
    },
    {
      id: "adjust",
      label: "clip:rail.adjust",
      hint: "clip:rail.adjustHint",
      icon: AdjustIcon,
    },
  ],
];

/**
 * The cutting room's left side: its rail of faces and the column they turn.
 *
 * The material and the three tools that work on it are one column with a rail
 * of drawers rather than four panels of their own, and the corner folds the
 * whole side away — rail and all — when the cut wants the room.
 */
export function ClipSide() {
  const face = useClipStore((state) => state.face);
  const setFace = useClipStore((state) => state.setFace);
  return (
    <WorkspaceSide
      active={face}
      columnClassName="clip-column"
      groups={GROUPS}
      label="clip:rail.label"
      onSelect={(id) => setFace(id as ClipFace)}
      testIdPrefix="clip-face"
    >
      <MediaColumn />
    </WorkspaceSide>
  );
}
