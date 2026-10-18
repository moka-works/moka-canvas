import { Fragment, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ExtensionDefinition, NodeKind } from "../../../shared/domain";
import { extensionPorts } from "../../../shared/domain";
import {
  addExtensionNodeAt,
  addNodeAt,
  kindAcceptsConnection,
  portsAcceptConnection,
  activeCanvas,
} from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useExtensionStore } from "../stores/extensionStore";
import { useClampedMenuPosition } from "./useClampedMenuPosition";

const GROUPS: {
  label: string;
  kinds: { kind: NodeKind; label: string }[];
}[] = [
  {
    label: "editor:nodeMenu.generationNodes",
    kinds: [
      { kind: "text", label: "domain:nodeTitle.text" },
      { kind: "image", label: "domain:nodeTitle.image" },
      { kind: "audio", label: "domain:nodeTitle.audio" },
      { kind: "video", label: "domain:nodeTitle.video" },
    ],
  },
  {
    label: "editor:nodeMenu.structure",
    kinds: [
      { kind: "operation", label: "domain:nodeTitle.operation" },
      { kind: "group", label: "domain:nodeTitle.group" },
      { kind: "export", label: "domain:nodeTitle.export" },
    ],
  },
];

/**
 * Quick-add menu: double-click on blank canvas, or the tail of a connection
 * dropped on blank space (then only compatible kinds are enabled).
 */
export function NodeMenu() {
  const { t, i18n } = useTranslation();
  const menu = useEditorStore((state) => state.nodeMenu);
  const catalog = useExtensionStore((state) => state.catalog);
  const loading = useExtensionStore((state) => state.loading);
  const error = useExtensionStore((state) => state.error);
  const load = useExtensionStore((state) => state.load);
  const { ref: listRef, pos } = useClampedMenuPosition(
    menu?.x ?? 0,
    menu?.y ?? 0,
  );
  const locale = (i18n.language || "en").split("-")[0];

  // Read when the menu opens, so a directory added since the last opening is
  // there without a restart and without watching a machine-level directory.
  useEffect(() => {
    if (menu) void load();
  }, [menu, load]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (
        listRef.current &&
        event.target instanceof Node &&
        !listRef.current.contains(event.target)
      ) {
        useEditorStore.getState().closeNodeMenu();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu, listRef]);

  if (!menu) return null;
  const canvas = activeCanvas();

  const pick = (kind: NodeKind) => {
    useEditorStore.getState().closeNodeMenu();
    addNodeAt(menu.world, kind, menu.connectFrom);
  };

  const pickExtension = (definition: ExtensionDefinition) => {
    useEditorStore.getState().closeNodeMenu();
    addExtensionNodeAt(definition, menu.world, menu.connectFrom);
  };

  const extensionCompatible = (definition: ExtensionDefinition) =>
    menu.connectFrom === null ||
    canvas === null ||
    portsAcceptConnection(
      canvas,
      menu.connectFrom,
      extensionPorts(definition, locale),
    );

  const onKeyDown = (event: React.KeyboardEvent) => {
    const items = listRef.current?.querySelectorAll("button:not(:disabled)");
    if (!items || items.length === 0) return;
    const index = [...items].findIndex(
      (item) => item === document.activeElement,
    );
    if (event.key === "ArrowDown") {
      event.preventDefault();
      (items[(index + 1) % items.length] as HTMLElement).focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (items[(index - 1 + items.length) % items.length] as HTMLElement).focus();
    }
  };

  return (
    <div
      aria-label={t("editor:nodeMenu.title")}
      className="menu node-menu"
      onKeyDown={onKeyDown}
      ref={listRef}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
    >
      {menu.connectFrom && (
        <p className="menu-title">{t("editor:nodeMenu.connectToNewNode")}</p>
      )}
      {GROUPS.map((group) => (
        <Fragment key={group.label}>
          <p className="menu-title">{t(group.label)}</p>
          {group.kinds.map(({ kind, label }) => {
            const disabled =
              menu.connectFrom !== null &&
              canvas !== null &&
              !kindAcceptsConnection(canvas, menu.connectFrom, kind);
            return (
              <button
                disabled={disabled}
                key={kind}
                onClick={() => pick(kind)}
                role="menuitem"
                type="button"
              >
                {t(label)}
              </button>
            );
          })}
        </Fragment>
      ))}
      <p className="menu-title">{t("editor:nodeMenu.extensionNodes")}</p>
      {catalog?.nodes.map((definition) => (
        <button
          disabled={!extensionCompatible(definition)}
          key={definition.id}
          onClick={() => pickExtension(definition)}
          role="menuitem"
          title={definition.description}
          type="button"
        >
          {definition.labels[locale]?.trim() || definition.displayName}
        </button>
      ))}
      {!loading && (catalog?.nodes.length ?? 0) === 0 && (
        <p className="menu-note">{t("editor:nodeMenu.noExtensions")}</p>
      )}
      {error && <p className="menu-note menu-note-error">{error}</p>}
      {catalog && catalog.problems.length > 0 && (
        <details className="menu-problems">
          <summary>
            {t("editor:nodeMenu.extensionProblems", {
              count: catalog.problems.length,
            })}
          </summary>
          <ul>
            {catalog.problems.map((problem) => (
              <li key={`${problem.id}-${problem.code}`}>
                <strong>{problem.id}</strong> {problem.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <button
        disabled={loading}
        onClick={() => void load(true)}
        role="menuitem"
        type="button"
      >
        {loading
          ? t("editor:nodeMenu.rescanning")
          : t("editor:nodeMenu.rescanExtensions")}
      </button>
      <p className="menu-title">{t("editor:nodeMenu.fromTheShelf")}</p>
      <button
        // A menu opened to finish a connection promises the node it makes will
        // be wired in, and a file off the shelf is not offered as one.
        disabled={menu.connectFrom !== null}
        onClick={() => {
          useEditorStore.getState().closeNodeMenu();
          useEditorStore
            .getState()
            .openAssetPicker({ mode: "nodes", at: menu.world });
        }}
        role="menuitem"
        type="button"
      >
        {t("editor:nodeMenu.fromAssets")}
      </button>
    </div>
  );
}
