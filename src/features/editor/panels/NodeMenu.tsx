import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DirectorTemplateId,
  ExtensionDefinition,
  NodeKind,
  Point,
} from "../../../shared/domain";
import { extensionPorts } from "../../../shared/domain";
import { DirectorTemplateDialog } from "../../director/components/DirectorTemplateDialog";
import {
  addDirectorNodeAt,
  addExtensionNodeAt,
  addNodeAt,
  kindAcceptsConnection,
  portsAcceptConnection,
  activeCanvas,
} from "../interactions/actions";
import { useEditorStore, type PortRef } from "../stores/editorStore";
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
      { kind: "director", label: "domain:nodeTitle.director" },
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

/** Space kept between a submenu and the window edge. */
const EDGE_GAP = 8;

/**
 * Quick-add menu: double-click on blank canvas, or the tail of a connection
 * dropped on blank space (then only compatible kinds are enabled).
 *
 * Installed extension nodes live one level down rather than in the first menu:
 * a machine may carry any number of definitions, and a first menu that grows
 * with every directory is a menu that has to be scrolled to find Text or Image.
 * The submenu is bounded by the window and scrolls inside that bound, so the
 * last definition is as reachable as the first.
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
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<{
    world: Point;
    connectFrom: PortRef | null;
  } | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  /** Whether the submenu was asked for with the keyboard and owes it focus. */
  const focusOnOpen = useRef(false);

  // Read when the menu opens, so a directory added since the last opening is
  // there without a restart and without watching a machine-level directory.
  useEffect(() => {
    if (menu) void load();
  }, [menu, load]);

  useEffect(() => {
    if (menu) return;
    setExtensionsOpen(false);
    setSubmenuPos(null);
  }, [menu]);

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

  // The submenu opens beside its trigger, flips to the other side when the
  // right edge would cut it off, and is pulled into the window vertically. Its
  // own height is already bounded by the stylesheet, so what is measured here
  // is what will actually be on screen.
  useLayoutEffect(() => {
    if (!extensionsOpen) return;
    const trigger = triggerRef.current;
    const submenu = submenuRef.current;
    if (!trigger || !submenu) return;
    const anchor = trigger.getBoundingClientRect();
    const box = submenu.getBoundingClientRect();
    let left = anchor.right + 2;
    if (left + box.width > window.innerWidth - EDGE_GAP) {
      left = anchor.left - box.width - 2;
    }
    setSubmenuPos({
      left: Math.max(
        EDGE_GAP,
        Math.min(left, window.innerWidth - box.width - EDGE_GAP),
      ),
      top: Math.max(
        EDGE_GAP,
        Math.min(anchor.top - 6, window.innerHeight - box.height - EDGE_GAP),
      ),
    });
    if (!focusOnOpen.current) return;
    focusOnOpen.current = false;
    submenu.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [extensionsOpen, catalog, loading, error]);

  if (!menu) {
    return (
      <DirectorTemplateDialog
        open={pendingTemplate !== null}
        onPick={chooseTemplate}
        onClose={() => setPendingTemplate(null)}
      />
    );
  }
  const canvas = activeCanvas();

  function chooseTemplate(template: DirectorTemplateId) {
    const target = pendingTemplate;
    setPendingTemplate(null);
    if (target) addDirectorNodeAt(target.world, target.connectFrom, template);
  }

  const pick = (kind: NodeKind) => {
    if (kind === "director") {
      setPendingTemplate({
        world: menu!.world,
        connectFrom: menu!.connectFrom,
      });
      useEditorStore.getState().closeNodeMenu();
      return;
    }
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

  const rootItems = () =>
    listRef.current?.querySelectorAll<HTMLElement>(
      ":scope > button:not(:disabled), :scope > .menu-submenu-entry > button:not(:disabled)",
    );

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Keys inside the submenu are its own: they move through its list and
    // close it before the menu behind them hears anything.
    if (
      submenuRef.current &&
      event.target instanceof Node &&
      submenuRef.current.contains(event.target)
    ) {
      return;
    }
    if (event.key === "Escape" && extensionsOpen) {
      event.preventDefault();
      event.stopPropagation();
      setExtensionsOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "ArrowRight" && event.target === triggerRef.current) {
      event.preventDefault();
      focusOnOpen.current = true;
      setExtensionsOpen(true);
      return;
    }
    if (event.key === "ArrowLeft" && extensionsOpen) {
      event.preventDefault();
      setExtensionsOpen(false);
      triggerRef.current?.focus();
      return;
    }
    const items = rootItems();
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

  const onSubmenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      setExtensionsOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = submenuRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled)",
    );
    if (!items || items.length === 0) return;
    const index = [...items].findIndex(
      (item) => item === document.activeElement,
    );
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
    event.preventDefault();
    items[next].focus();
    items[next].scrollIntoView({ block: "nearest" });
  };

  const openExtensions = () => {
    if (extensionsOpen) {
      // Hover may already have opened it; a click then means the reader wants
      // to be in the list, not that they want it taken away again.
      submenuRef.current
        ?.querySelector<HTMLElement>("button:not(:disabled)")
        ?.focus();
      return;
    }
    setSubmenuPos(null);
    setExtensionsOpen(true);
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
      <div className="menu-submenu-entry" role="none">
        <button
          aria-controls="extension-node-submenu"
          aria-expanded={extensionsOpen}
          aria-haspopup="menu"
          className="menu-submenu-trigger"
          onClick={openExtensions}
          onPointerEnter={() => {
            if (extensionsOpen) return;
            openExtensions();
          }}
          ref={triggerRef}
          role="menuitem"
          type="button"
        >
          <span>{t("editor:nodeMenu.extensionNodes")}</span>
          <span aria-hidden="true" className="menu-chevron">
            ▸
          </span>
        </button>
        {extensionsOpen && (
          <div
            aria-label={t("editor:nodeMenu.extensionNodes")}
            className="menu node-submenu"
            id="extension-node-submenu"
            onKeyDown={onSubmenuKeyDown}
            ref={submenuRef}
            role="menu"
            style={{
              left: submenuPos?.left ?? 0,
              top: submenuPos?.top ?? 0,
              visibility: submenuPos ? "visible" : "hidden",
            }}
          >
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
            {loading && !catalog && (
              <p className="menu-note">{t("editor:nodeMenu.rescanning")}</p>
            )}
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
          </div>
        )}
      </div>
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
