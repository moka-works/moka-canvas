import { useTranslation } from "react-i18next";

/**
 * The blocking lane's place in the layout before the motion tools arrive.
 *
 * The strip only appears with the motion tools: it is the clock the whole
 * shot is worked against, and a timeline beside a staging desk that is not
 * following a clock would be a row of controls with nothing to move.
 */
export function BlockingLanePlaceholder({
  collapsed,
  onCollapse,
}: {
  collapsed: boolean;
  onCollapse: () => void;
}) {
  const { t } = useTranslation("director");
  if (collapsed) {
    return (
      <button
        className="director-blocking-collapsed"
        onClick={onCollapse}
        type="button"
      >
        {t("blocking.show")}
      </button>
    );
  }
  return (
    <section aria-label={t("blocking.title")} className="director-blocking">
      <header>
        <h2>{t("blocking.title")}</h2>
        <button className="button" onClick={onCollapse} type="button">
          {t("blocking.hide")}
        </button>
      </header>
      <p>{t("blocking.pending")}</p>
    </section>
  );
}
