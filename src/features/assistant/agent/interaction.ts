import type { AgentRoom } from "../../../api";
import type { ApprovalView, QuestionView } from "./types";

/**
 * The two places the loop stops for a person, one per room.
 *
 * The promises are module-level rather than store state because they are not
 * read by a renderer: the dock shows the view beside them, and the button
 * resolves the promise the loop is waiting on. Everything else in the store is
 * data; these are open questions. A room asks its own, so a turn waiting in
 * the cutting room is not answered by a click in the shelf.
 */

let approvals = new Map<
  AgentRoom,
  { view: ApprovalView; resolve: (approved: boolean) => void }
>();

let questions = new Map<
  AgentRoom,
  { view: QuestionView; resolve: (answer: string | null) => void }
>();

export function requestApproval(
  room: AgentRoom,
  view: ApprovalView,
): Promise<boolean> {
  return new Promise((resolve) => {
    approvals.set(room, { view, resolve });
    notifyApproval(room, view);
  });
}

export function settleApproval(room: AgentRoom, approved: boolean): void {
  const standing = approvals.get(room);
  approvals = new Map([...approvals].filter(([each]) => each !== room));
  notifyApproval(room, null);
  standing?.resolve(approved);
}

export function currentApproval(room: AgentRoom): ApprovalView | null {
  return approvals.get(room)?.view ?? null;
}

export function requestQuestion(
  room: AgentRoom,
  view: QuestionView,
): Promise<string | null> {
  return new Promise((resolve) => {
    questions.set(room, { view, resolve });
    notifyQuestion(room, view);
  });
}

export function settleQuestion(room: AgentRoom, answer: string | null): void {
  const standing = questions.get(room);
  questions = new Map([...questions].filter(([each]) => each !== room));
  notifyQuestion(room, null);
  standing?.resolve(answer);
}

export function currentQuestion(room: AgentRoom): QuestionView | null {
  return questions.get(room)?.view ?? null;
}

// The store subscribes here so the dock re-renders when a question stands or
// is answered; the loop does not import the store and the store does not own
// the promise.
let approvalListener:
  ((room: AgentRoom, view: ApprovalView | null) => void) | null = null;
let questionListener:
  ((room: AgentRoom, view: QuestionView | null) => void) | null = null;

export function watchInteractions(listeners: {
  approval: (room: AgentRoom, view: ApprovalView | null) => void;
  question: (room: AgentRoom, view: QuestionView | null) => void;
}): void {
  approvalListener = listeners.approval;
  questionListener = listeners.question;
}

function notifyApproval(room: AgentRoom, view: ApprovalView | null): void {
  approvalListener?.(room, view);
}

function notifyQuestion(room: AgentRoom, view: QuestionView | null): void {
  questionListener?.(room, view);
}
