import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * The short menu a card keeps its less-used actions behind.
 *
 * A row closes the menu as it acts, and a menu is left by clicking anywhere
 * else on the page, or by stepping back with Escape, as any other menu is.
 */
export function MoreMenu({
  children,
  testId,
}: {
  /** The rows, handed the way to close the menu after one is pressed. */
  children: (close: () => void) => ReactNode;
  testId: string;
}) {
  const { t } = useTranslation();
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => {
    if (menu.current !== null) menu.current.open = false;
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const element = menu.current;
      if (element === null) return;
      if (event.target instanceof Node && element.contains(event.target))
        return;
      close();
    };
    const back = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      menu.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", back);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", back);
    };
  }, [open]);
  return (
    <details className="story-kf-more" data-testid={testId} ref={menu}>
      <summary className="story-kf-more-toggle" onClick={() => setOpen(!open)}>
        {t("story:panels.more")}
      </summary>
      {open && <span className="story-kf-more-menu">{children(close)}</span>}
    </details>
  );
}
