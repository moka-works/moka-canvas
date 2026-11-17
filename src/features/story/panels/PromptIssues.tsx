import { useTranslation } from "react-i18next";

import type { PromptContractIssue } from "../../../shared/prompts/promptContract";

/**
 * What a rewrite still gets wrong, named beside the words it wrote.
 *
 * The contract is advisory: the reader may send the words as they stand. The
 * list is the same whichever medium the prompt is for, so a reader learns it
 * once.
 */
export function PromptIssues({
  issues,
  testId,
  className = "story-video-prompt-issues",
}: {
  issues: PromptContractIssue[];
  /** The list's own test id, so each dialog can be found by its surface. */
  testId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  const issueText = (issue: PromptContractIssue): string => {
    switch (issue.code) {
      case "empty":
        return t("common:promptIssues.empty");
      case "tooLong":
        return t("common:promptIssues.tooLong", { max: issue.max });
      case "unbalancedTags":
        return t("common:promptIssues.tags", { tag: issue.tag });
      case "dialogueMissing":
        return t("common:promptIssues.line", { line: issue.line });
      case "unknownSpeaker":
        return t("common:promptIssues.speaker", { ref: issue.ref });
      case "bodyNotEnglish":
        return t("common:promptIssues.language", { sample: issue.sample });
      case "negativeInstruction":
        return t("common:promptIssues.negative", { phrase: issue.phrase });
      case "mentionMissing":
        return t("common:promptIssues.mentionMissing", { token: issue.token });
      case "mentionUnknown":
        return t("common:promptIssues.mentionUnknown", { token: issue.token });
    }
  };
  return (
    <div className={className} data-testid={testId} role="status">
      <span className="story-video-prompt-issues-title">
        {t("common:promptIssues.title")}
      </span>
      <ul>
        {issues.map((issue, at) => (
          <li key={`${issue.code}-${at}`}>{issueText(issue)}</li>
        ))}
      </ul>
    </div>
  );
}
