import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SecretStorageChoice } from "../../api";
import { CAPABILITY_LABELS } from "../../shared/domain";
import { useLocale, type LocaleMode } from "../../shared/i18n";
import { UpdateSection } from "../update/UpdateSection";
import { useModelStore } from "./modelStore";
import { SecretStorageNote } from "./SecretStorageNote";

const CHOICE_LABELS: Record<SecretStorageChoice, string> = {
  file: "settings:system.tierFile",
  keyring: "settings:system.tierKeyring",
};

/**
 * Which language the interface is drawn in.
 *
 * Following the machine is the start; picking a language outright keeps it
 * through restarts and outranks the machine's own choice. The choice is kept
 * on this machine rather than in the document, like the other choices that are
 * about the reader rather than about the work.
 */
function LanguageChoice() {
  const { t } = useTranslation();
  const mode = useLocale((state) => state.mode);
  return (
    <section
      aria-label={t("settings:language.title")}
      className="settings-section"
    >
      <h3 className="settings-heading">{t("settings:language.title")}</h3>
      <label className="dialog-field">
        <span>{t("settings:language.label")}</span>
        <select
          onChange={(event) =>
            useLocale.getState().setMode(event.target.value as LocaleMode)
          }
          value={mode}
        >
          <option value="system">{t("settings:language.system")}</option>
          <option value="en">{t("settings:language.english")}</option>
          <option value="zh">{t("settings:language.chinese")}</option>
        </select>
      </label>
    </section>
  );
}

/**
 * What is global: the language the interface is drawn in, where the master key
 * protecting the stored credentials lives, and which credentials exist.
 *
 * The tier is a choice only desktop macOS and Windows builds can make — a
 * server has no keychain to ask, so it keeps the file tier (or the exported
 * MOKA_METADATA_KEY, which always wins and cannot be moved from here).
 * Switching moves the same master key between its homes: stored credentials
 * keep opening, because the key that seals them does not change.
 */
export function SystemTab() {
  const { t } = useTranslation();
  const view = useModelStore((state) => state.view);
  const saving = useModelStore((state) => state.saving);
  const [managing, setManaging] = useState(false);

  if (!view) {
    return (
      <div className="settings-section">
        <UpdateSection />
        <p className="settings-hint">{t("settings:loading")}</p>
      </div>
    );
  }

  const options = view.secretStorageOptions ?? ["file"];
  const current = view.secretStorage;
  // The radio shows the tier that holds the key; before any key exists it
  // shows the tier the first one would be created in.
  const selected: SecretStorageChoice =
    current === "file" || current === "keyring"
      ? current
      : (view.secretStoragePref ?? "file");
  const envLocked = current === "env";
  const switchable = !envLocked && options.length > 1;

  const storedKeys = view.models.filter((model) => model.apiKey.set);

  const switchTo = (choice: SecretStorageChoice) => {
    if (choice === selected) return;
    const verdict = window.confirm(
      choice === "keyring"
        ? t("settings:system.switchToKeyring")
        : t("settings:system.switchToFile"),
    );
    if (!verdict) return;
    void useModelStore.getState().setSecretStorage(choice);
  };

  const removeKey = (id: string, displayName: string) => {
    if (
      !window.confirm(t("settings:system.removeKey", { name: displayName }))
    ) {
      return;
    }
    void useModelStore.getState().setKey(id, null);
  };

  return (
    <div className="settings-section">
      <UpdateSection />
      <LanguageChoice />

      <h3 className="settings-heading">{t("settings:system.storage")}</h3>
      <SecretStorageNote tier={current} />
      {options.map((choice) => (
        <label className="settings-check" key={choice}>
          <input
            aria-label={t(CHOICE_LABELS[choice])}
            checked={selected === choice}
            disabled={saving || !switchable}
            name="secret-storage"
            onChange={() => switchTo(choice)}
            type="radio"
            value={choice}
          />
          <span>{t(CHOICE_LABELS[choice])}</span>
        </label>
      ))}
      {envLocked && (
        <p className="settings-hint">{t("settings:system.envLocked")}</p>
      )}
      {!switchable && !envLocked && options.length < 2 && (
        <p className="settings-hint">{t("settings:system.noKeychain")}</p>
      )}

      <h3 className="settings-heading">{t("settings:system.storedKeys")}</h3>
      <div className="settings-row">
        <button
          disabled={saving}
          onClick={() => setManaging((open) => !open)}
          type="button"
        >
          {managing
            ? t("settings:system.hideKeys")
            : storedKeys.length === 0
              ? t("settings:system.manageKeys")
              : t("settings:system.manageKeysCount", {
                  count: storedKeys.length,
                })}
        </button>
      </div>
      {managing &&
        (storedKeys.length === 0 ? (
          <p className="settings-hint">{t("settings:system.noneStored")}</p>
        ) : (
          <ul className="key-list">
            {storedKeys.map((model) => (
              <li key={model.id}>
                <div className="key-list-info">
                  <span className="key-list-name">{model.displayName}</span>
                  <span className="settings-hint">
                    {t(CAPABILITY_LABELS[model.category]).toLowerCase()} ·{" "}
                    {model.id}
                    {view.defaults[model.category] === model.id
                      ? t("settings:system.categoryDefault")
                      : ""}
                  </span>
                  <span className="settings-hint">
                    {model.apiKey.masked ?? t("settings:keyFallback")}
                    {model.apiKey.rotatedAt
                      ? t("settings:system.rotated", {
                          date: model.apiKey.rotatedAt.slice(0, 10),
                        })
                      : ""}
                  </span>
                </div>
                <button
                  disabled={saving}
                  onClick={() => removeKey(model.id, model.displayName)}
                  type="button"
                >
                  {t("settings:delete")}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
