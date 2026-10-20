import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DirectorTemplateId } from "../../../shared/domain";
import { DirectorTemplateDialog } from "../../director/components/DirectorTemplateDialog";
import { openDirector } from "../../director/stores/directorStore";
import { viewCenterWorld } from "../canvas/canvasControl";
import { addDirectorNodeAt } from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useActiveCanvas } from "../stores/projectStore";

/**
 * The canvas bar's way into the desk.
 *
 * A board may hold several desks, so the tab opens the selected one, offers
 * the ones on this board by name, or — when the board has none — asks which
 * starting point a new one should take. It never creates a scene without
 * asking, and it never guesses which of several cards was meant.
 */
export function DirectorTab() {
  const { t } = useTranslation(["director", "editor"]);
  const canvas = useActiveCanvas();
  const selected = useEditorStore((state) => state.selection.nodeIds);
  const [listOpen, setListOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const desks = canvas?.nodes.filter((node) => node.kind === "director") ?? [];
  const selectedDesk = desks.find((node) => selected.includes(node.id));

  const create = (template: DirectorTemplateId) => {
    setTemplateOpen(false);
    const world = viewCenterWorld() ?? { x: 0, y: 0 };
    addDirectorNodeAt(world, null, template);
  };

  return (
    <div className="director-canvas-tab">
      <button
        aria-expanded={listOpen}
        className="director-entry-tab"
        disabled={!canvas}
        onClick={() => {
          if (selectedDesk) {
            openDirector(selectedDesk.id);
            return;
          }
          if (desks.length === 0) {
            setTemplateOpen(true);
            return;
          }
          setListOpen((held) => !held);
        }}
        ref={buttonRef}
        title={t("director:entry.title")}
        type="button"
      >
        ◈ {t("director:entry.tab")}
      </button>
      {listOpen && (
        <>
          <div
            className="director-entry-backdrop"
            onClick={() => setListOpen(false)}
            role="presentation"
          />
          <div
            aria-label={t("director:entry.choose")}
            className="menu director-entry-menu"
            role="menu"
          >
            <p className="menu-title">{t("director:entry.choose")}</p>
            {desks.map((node) => (
              <button
                key={node.id}
                onClick={() => {
                  setListOpen(false);
                  openDirector(node.id);
                }}
                role="menuitem"
                type="button"
              >
                {node.title}
              </button>
            ))}
            <button
              onClick={() => {
                setListOpen(false);
                setTemplateOpen(true);
              }}
              role="menuitem"
              type="button"
            >
              + {t("director:entry.new")}
            </button>
          </div>
        </>
      )}
      <DirectorTemplateDialog
        onClose={() => setTemplateOpen(false)}
        onPick={create}
        open={templateOpen}
      />
    </div>
  );
}
