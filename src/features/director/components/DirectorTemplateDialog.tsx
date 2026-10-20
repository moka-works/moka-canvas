import { useTranslation } from "react-i18next";
import {
  DIRECTOR_TEMPLATE_IDS,
  DIRECTOR_TEMPLATE_LABELS,
  type DirectorTemplateId,
} from "../../../shared/domain";

export interface DirectorTemplateDialogProps {
  open: boolean;
  onPick: (template: DirectorTemplateId) => void;
  onClose: () => void;
}

/**
 * The five starting points a new desk offers.
 *
 * Empty is first because it is the honest default: a template brings actors
 * and furniture, and a reader who wanted none should not have to delete them.
 */
export function DirectorTemplateDialog({
  open,
  onPick,
  onClose,
}: DirectorTemplateDialogProps) {
  const { t } = useTranslation(["director", "editor"]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div
        aria-labelledby="director-template-title"
        aria-modal="true"
        className="dialog director-template-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <h2 id="director-template-title">
          {t("director:templates.dialogTitle")}
        </h2>
        <p className="dialog-note">{t("director:templates.dialogNote")}</p>
        <div className="director-template-grid">
          {DIRECTOR_TEMPLATE_IDS.map((template) => (
            <button
              className="director-template-choice"
              key={template}
              onClick={() => onPick(template)}
              type="button"
            >
              <strong>{t(DIRECTOR_TEMPLATE_LABELS[template])}</strong>
              <span>{t(`director:templates.${template}.description`)}</span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="button" onClick={onClose} type="button">
            {t("editor:actions.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
