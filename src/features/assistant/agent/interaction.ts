import type { ApprovalView, QuestionView } from "./types";

/**
 * The two places the loop stops for a person.
 *
 * The promises are module-level rather than store state because they are not
 * read by a renderer: the dock shows the view beside them, and the button
 * resolves the promise the loop is waiting on. Everything else in the store is
 * data; these are open questions.
 */

let approval: {
  view: ApprovalView;
  resolve: (approved: boolean) => void;
} | null = null;

let question: {
  view: QuestionView;
  resolve: (answer: string | null) => void;
} | null = null;

export function requestApproval(view: ApprovalView): Promise<boolean> {
  return new Promise((resolve) => {
    approval = { view, resolve };
    notifyApproval(view);
  });
}

export function settleApproval(approved: boolean): void {
  const standing = approval;
  approval = null;
  notifyApproval(null);
  standing?.resolve(approved);
}

export function currentApproval(): ApprovalView | null {
  return approval?.view ?? null;
}

export function requestQuestion(view: QuestionView): Promise<string | null> {
  return new Promise((resolve) => {
    question = { view, resolve };
    notifyQuestion(view);
  });
}

export function settleQuestion(answer: string | null): void {
  const standing = question;
  question = null;
  notifyQuestion(null);
  standing?.resolve(answer);
}

export function currentQuestion(): QuestionView | null {
  return question?.view ?? null;
}

// The store subscribes here so the dock re-renders when a question stands or
// is answered; the loop does not import the store and the store does not own
// the promise.
let approvalListener: ((view: ApprovalView | null) => void) | null = null;
let questionListener: ((view: QuestionView | null) => void) | null = null;

export function watchInteractions(listeners: {
  approval: (view: ApprovalView | null) => void;
  question: (view: QuestionView | null) => void;
}): void {
  approvalListener = listeners.approval;
  questionListener = listeners.question;
}

function notifyApproval(view: ApprovalView | null): void {
  approvalListener?.(view);
}

function notifyQuestion(view: QuestionView | null): void {
  questionListener?.(view);
}
