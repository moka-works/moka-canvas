import { Fragment, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  findNode,
  generationCapabilityFor,
  type GenerationSpec,
} from "../../../shared/domain";
import {
  activeCanvas,
  chooseResult,
  choosableResults,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  fileNodeAsAsset,
  filingPossible,
  fitViewAction,
  generateFrom,
  groupSelection,
  pasteAt,
  selectAll,
  ungroupSelection,
} from "../interactions/actions";
import { useAppStore } from "../stores/appStore";
import { errorText } from "../../../api/client";
import { useEditorStore } from "../stores/editorStore";
import { i18n } from "../../../shared/i18n";
import { isActive, nodeRun, retryRun, useRunStore } from "../stores/runStore";
import { useClampedMenuPosition } from "./useClampedMenuPosition";

interface Item {
  label: string;
  /** A heading for the item and the ones under it that share its subject. */
  title?: string;
  disabled?: boolean;
  action: () => void;
}

/**
 * Puts what a node asks for on the system clipboard, to be read somewhere else.
 *
 * Said either way round: a clipboard the window is not allowed to write to
 * fails quietly, and a menu that closed without a word would leave the choice
 * looking as though it had worked.
 */
async function copyPrompt(prompt: string) {
  try {
    await navigator.clipboard.writeText(prompt);
    useEditorStore.getState().announce(i18n.t("editor:menu.promptCopied"));
  } catch (problem) {
    useAppStore
      .getState()
      .pushToast(
        "error",
        i18n.t("editor:menu.clipboardUnavailable"),
        undefined,
        errorText(problem).message,
      );
  }
}

/**
 * Right-click menu. Offers what the toolstrip and the inspector offer for the
 * thing pointed at, and nothing that needs a place of its own; opening it on a
 * node or edge selects that target first (handled by the canvas callback).
 */
export function ContextMenu() {
  const { t } = useTranslation();
  const menu = useEditorStore((state) => state.contextMenu);
  const { ref: listRef, pos } = useClampedMenuPosition(
    menu?.x ?? 0,
    menu?.y ?? 0,
  );

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (
        listRef.current &&
        event.target instanceof Node &&
        !listRef.current.contains(event.target)
      ) {
        useEditorStore.getState().closeContextMenu();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu, listRef]);

  if (!menu) return null;
  const editor = useEditorStore.getState();
  const canvas = activeCanvas();

  const items: Item[] = [];
  if (menu.target.kind === "node" || menu.target.kind === "port") {
    const targetId = menu.target.nodeId;
    const selectedCount = editor.selection.nodeIds.length;
    const targetNode = canvas ? findNode(canvas, targetId) : undefined;
    if (targetNode && generationCapabilityFor(targetNode.kind) !== null) {
      items.push({
        label: t("editor:menu.generate"),
        action: () => editor.openPromptPanel(targetId, true),
      });
    }
    if (targetNode?.kind === "extension") {
      items.push({
        label: t("editor:menu.configureExtension"),
        action: () => editor.openExtensionPanel(targetId, true),
      });
    }
    // Words are a place to start from rather than only a thing to ask about:
    // what is made of them sits beside them and is fed by them, with its own
    // panel opened and nothing asked for yet.
    const words = (targetNode?.data as { content?: string } | undefined)
      ?.content;
    if (targetNode?.kind === "text" && words && words.trim() !== "") {
      items.push(
        {
          title: t("editor:menu.generateTitle"),
          label: t("editor:menu.imageFromWords"),
          action: () => generateFrom(targetId, "image"),
        },
        {
          label: t("editor:menu.videoFromWords"),
          action: () => generateFrom(targetId, "video"),
        },
        {
          label: t("editor:menu.audioFromWords"),
          action: () => generateFrom(targetId, "audio"),
        },
        {
          label: t("editor:menu.rewriteWords"),
          action: () => generateFrom(targetId, "text"),
        },
      );
    }
    // Read at the moment the menu is opened rather than watched: it is not on
    // screen long enough for a record arriving while it is open to matter.
    const asked = targetNode ? nodeRun(targetId) : null;
    // This node's own step rather than the run's whole, for the reason the
    // inspector gives: a run of several nodes is still going after one of them
    // has landed, and that one has nothing left to stop.
    const going = asked !== null && isActive(asked.step.status);
    if (asked && going) {
      const runId = asked.run.id;
      items.push({
        label: t("editor:action.stop"),
        action: () => void useRunStore.getState().cancel(runId),
      });
    }
    if (
      asked &&
      !going &&
      (asked.run.status === "failed" || asked.run.status === "cancelled")
    ) {
      const runId = asked.run.id;
      items.push({
        label: t("editor:action.retry"),
        action: () => void retryRun(runId),
      });
    }
    if (targetNode) {
      const spec = (targetNode.data as { generation?: GenerationSpec })
        .generation;
      if (spec && spec.prompt.trim() !== "") {
        items.push({
          label: t("editor:menu.copyPrompt"),
          action: () => void copyPrompt(spec.prompt),
        });
      }
      if (canvas) {
        for (const choice of choosableResults(canvas, targetNode)) {
          items.push({
            label: choice.label,
            action: () => chooseResult(targetId, choice.slotId),
          });
        }
      }
      if (canvas && filingPossible(targetNode)) {
        items.push({
          label: t("editor:menu.saveAsMaterial"),
          action: () => void fileNodeAsAsset(canvas.id, targetId),
        });
      }
    }
    items.push(
      {
        label: t("editor:action.rename"),
        action: () => editor.startRenaming(targetId),
      },
      {
        label: t("editor:action.duplicate"),
        action: () => void duplicateSelection(),
      },
      { label: t("editor:action.copy"), action: () => void copySelection() },
      { label: t("editor:action.cut"), action: () => void cutSelection() },
      {
        label: t("editor:action.group"),
        disabled: selectedCount < 2,
        action: () => groupSelection(),
      },
      {
        label: t("editor:action.ungroup"),
        disabled: targetNode?.kind !== "group",
        action: () => ungroupSelection(),
      },
      { label: t("editor:action.delete"), action: () => deleteSelection() },
    );
  } else if (menu.target.kind === "edge") {
    items.push({
      label: t("editor:menu.deleteEdge"),
      action: () => deleteSelection(),
    });
  } else {
    const world = menu.target.world;
    items.push(
      { label: t("editor:menu.pasteHere"), action: () => void pasteAt(world) },
      { label: t("editor:menu.selectAll"), action: () => selectAll() },
      { label: t("editor:page.fitView"), action: () => fitViewAction() },
      {
        label: t("editor:nodeMenu.title"),
        action: () => {
          editor.openNodeMenu({
            x: menu.x,
            y: menu.y,
            world,
            connectFrom: null,
          });
        },
      },
    );
  }

  const run = (item: Item) => {
    useEditorStore.getState().closeContextMenu();
    item.action();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = listRef.current?.querySelectorAll("button:not(:disabled)");
    if (!buttons || buttons.length === 0) return;
    const index = [...buttons].findIndex(
      (item) => item === document.activeElement,
    );
    if (event.key === "ArrowDown") {
      event.preventDefault();
      (buttons[(index + 1) % buttons.length] as HTMLElement).focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (
        buttons[(index - 1 + buttons.length) % buttons.length] as HTMLElement
      ).focus();
    }
  };

  return (
    <div
      aria-label={t("editor:menu.contextMenu")}
      className="menu context-menu"
      onKeyDown={onKeyDown}
      ref={listRef}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.title && <p className="menu-title">{item.title}</p>}
          <button
            disabled={item.disabled}
            onClick={() => run(item)}
            role="menuitem"
            type="button"
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
