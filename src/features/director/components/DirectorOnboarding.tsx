import { useTranslation } from "react-i18next";

const STEPS = [
  "addActor",
  "placeActor",
  "poseActor",
  "recordKeys",
  "checkFrame",
  "recordBlocking",
  "deliver",
] as const;

/**
 * Seven steps through the desk, kept on this machine.
 *
 * The guide is a card over the corner of the viewport, not a modal: a reader
 * following it is looking at the stage, and a dialog over the picture would
 * hide the thing the step is about. It can be skipped, resumed from the top
 * bar, and is done for good once finished or skipped.
 */
export function DirectorOnboarding({
  open,
  step,
  onNext,
  onBack,
  onSkip,
  onFinish,
}: {
  open: boolean;
  step: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onFinish: () => void;
}) {
  const { t } = useTranslation("director");
  if (!open) return null;
  const last = step >= STEPS.length - 1;
  return (
    <aside
      aria-label={t("onboarding.title")}
      className="director-onboarding"
      role="dialog"
    >
      <p className="director-onboarding-count">
        {t("onboarding.step", { current: step + 1, total: STEPS.length })}
      </p>
      <h2>{t(`onboarding.${STEPS[step]}.title`)}</h2>
      <p>{t(`onboarding.${STEPS[step]}.body`)}</p>
      <div className="director-onboarding-actions">
        <button className="button" onClick={onSkip} type="button">
          {t("onboarding.skip")}
        </button>
        <span>
          {step > 0 && (
            <button className="button" onClick={onBack} type="button">
              {t("onboarding.back")}
            </button>
          )}
          <button
            className="button is-primary"
            onClick={last ? onFinish : onNext}
            type="button"
          >
            {last ? t("onboarding.finish") : t("onboarding.next")}
          </button>
        </span>
      </div>
    </aside>
  );
}
