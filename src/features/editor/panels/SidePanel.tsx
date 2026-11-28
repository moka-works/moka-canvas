import {
  WorkspaceSide,
  type WorkspaceFace,
} from "../../workspace/WorkspaceSide";
import { AssetsIcon, CanvasesIcon } from "../../workspace/icons";
import { useEditorStore, type LeftPanelTab } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { AssetsPanel } from "./AssetsPanel";
import { ProjectTree } from "./ProjectTree";

interface RailFace extends WorkspaceFace {
  id: LeftPanelTab;
}

/** What the column beside the canvas can show, in the order the rail reads. */
const GROUPS: readonly (readonly RailFace[])[] = [
  [
    {
      id: "project",
      label: "editor:sidePanel.project",
      hint: "editor:sidePanel.projectHint",
      icon: CanvasesIcon,
    },
    {
      id: "assets",
      label: "editor:sidePanel.assets",
      hint: "editor:sidePanel.assetsHint",
      icon: AssetsIcon,
    },
  ],
];

/**
 * The column on the left of the canvas, and the choice of what it shows.
 *
 * Two faces of one column rather than two columns: what a project holds — its
 * boards, the folders they are filed in, and what each board is made of — and
 * what it is made of altogether, the files a board can be given. They are read
 * together often enough to sit beside each other, and a canvas narrow enough to
 * need one of them folded away needs the other folded away too.
 *
 * Following a file from the tree to the shelf turns the column over rather than
 * opening anything, which is the point of two faces of one thing: what a reader
 * was looking at is still beside what they were looking at it in.
 *
 * The corner of the column folds the whole side away — rail and all — for a
 * canvas that wants the room; what is left in that corner of the window brings
 * it back.
 */
export function SidePanel() {
  const moka = useProjectStore((state) => state.moka);
  const tab = useEditorStore((state) => state.leftPanelTab);
  const setTab = useEditorStore((state) => state.setLeftPanelTab);
  if (!moka) return null;

  return (
    <WorkspaceSide
      active={tab}
      columnClassName="editor-side"
      groups={GROUPS}
      label="editor:sidePanel.columnShows"
      onSelect={(id) => setTab(id as LeftPanelTab)}
      testIdPrefix="left-tab"
    >
      {tab === "project" ? <ProjectTree /> : <AssetsPanel />}
    </WorkspaceSide>
  );
}
