import type { ComponentType, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PanelFold } from "../editor/components/PanelFold";

/** One drawer of a workspace's rail, and the face it turns the column to. */
export interface WorkspaceFace {
  /** The face's id in the page's own store. */
  id: string;
  /** What the face is called, as a translation key. */
  label: string;
  /** What the face is for, as a translation key. */
  hint: string;
  icon: ComponentType<{ size?: number }>;
}

interface WorkspaceSideProps {
  /** What the rail is read as, as a translation key. */
  label: string;
  /** The faces in the order the rail shows them, in the groups they stand in. */
  groups: readonly (readonly WorkspaceFace[])[];
  active: string;
  onSelect: (id: string) => void;
  /** The page's own name for the column, which carries its width and borders. */
  columnClassName: string;
  /** The prefix the face buttons are found by in tests. */
  testIdPrefix: string;
  children: ReactNode;
}

/**
 * The left side of a room: a rail of drawers and the column it turns over.
 *
 * The cutting room, the board and the story room all hold their choices this
 * way — a row of marks down the edge of the window, and one column beside it
 * showing the face that is standing. Keeping the rail and the column here means
 * a change to either is made once rather than in every room, and every room
 * folds the same way: the triangle in the column's corner puts the rail away
 * with it, since a rail with no column to turn is a row of dead buttons.
 *
 * What a face shows is the page's business; the rail only says which one is
 * standing and hands the choice back.
 */
export function WorkspaceSide({
  label,
  groups,
  active,
  onSelect,
  columnClassName,
  testIdPrefix,
  children,
}: WorkspaceSideProps) {
  const { t } = useTranslation();
  return (
    <>
      <aside aria-label={t(label)} className="work-rail" role="tablist">
        {groups.map((group, index) => (
          <div className="work-rail-group" key={index}>
            {group.map(({ id, label: name, hint, icon: Icon }) => (
              <button
                aria-label={t(name)}
                aria-selected={active === id}
                className={
                  active === id ? "work-rail-item is-active" : "work-rail-item"
                }
                data-testid={`${testIdPrefix}-${id}`}
                key={id}
                onClick={() => onSelect(id)}
                role="tab"
                title={t(hint)}
                type="button"
              >
                <Icon />
              </button>
            ))}
          </div>
        ))}
      </aside>
      <aside
        aria-label={t(label)}
        className={`work-column ${columnClassName}`}
        id="panel-left"
      >
        <PanelFold side="left" />
        {children}
      </aside>
    </>
  );
}
