/**
 * Same-target guard for approval cards.
 *
 * A connector tool can declare which of its arguments identify the thing it changes (for example
 * `post_id` and `widget_id`) through the MCP tool `_meta` key `rakazo/approvalTarget`. Before a new
 * card is filed, earlier effects of the same tool on the same target are checked: one still
 * waiting for an answer means the new card would be a duplicate, and one completed recently means
 * the bot may be redoing work it already finished.
 */

import { boundDirectApprovalDetails } from "./approval-effect.js";

export const APPROVAL_TARGET_META_KEY = "rakazo/approvalTarget";

/** How far back a completed change on the same target is worth flagging. */
export const APPROVAL_TARGET_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const MAX_TARGET_KEYS = 8;
const PENDING_STATUSES = new Set(["intended", "approved", "executing"]);

export type ApprovalTarget = Record<string, string | number | boolean | null>;

export type PriorEffect = {
  id: string;
  status: string;
  request: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type SameTargetMatch = { effect: PriorEffect; args: Record<string, unknown> };

/** Reads `_meta["rakazo/approvalTarget"]` from a listed MCP tool. */
export function approvalTargetKeysFromMeta(meta: unknown): string[] | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const keys = (meta as Record<string, unknown>)[APPROVAL_TARGET_META_KEY];
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_TARGET_KEYS) return undefined;
  if (!keys.every((key) => typeof key === "string" && key.length > 0 && key.length <= 64)) {
    return undefined;
  }
  return keys as string[];
}

/**
 * The declared target of a call, or undefined when none of its keys is set (for example a
 * publish call that creates a new post has no `post_id` yet). Only scalar values identify.
 */
export function approvalTargetOf(
  args: Record<string, unknown>,
  keys: string[],
): ApprovalTarget | undefined {
  const target: ApprovalTarget = {};
  let present = false;
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null) {
      target[key] = null;
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return undefined;
    }
    target[key] = value;
    present = true;
  }
  return present ? target : undefined;
}

function sameTarget(args: Record<string, unknown>, target: ApprovalTarget): boolean {
  return Object.entries(target).every(([key, value]) => {
    const other = args[key];
    if (value === null) return other === undefined || other === null;
    return other === value || (other !== undefined && String(other) === String(value));
  });
}

/**
 * Finds the most relevant earlier effect on the same target of the same bound tool: a pending
 * one first, otherwise the newest completed one inside the lookback window.
 */
export function findSameTargetEffect(input: {
  effects: PriorEffect[];
  target: ApprovalTarget;
  route: { resourceId: string; toolName: string };
  marker: string;
  now: Date;
}): { pending?: SameTargetMatch; completed?: SameTargetMatch } {
  let pending: SameTargetMatch | undefined;
  let completed: SameTargetMatch | undefined;
  for (const effect of input.effects) {
    const details = boundDirectApprovalDetails(effect.request, input.marker);
    if (
      !details ||
      details.route.resourceId !== input.route.resourceId ||
      details.route.toolName !== input.route.toolName ||
      !sameTarget(details.args, input.target)
    ) {
      continue;
    }
    if (PENDING_STATUSES.has(effect.status)) {
      if (!pending || effect.createdAt > pending.effect.createdAt) {
        pending = { effect, args: details.args };
      }
    } else if (
      effect.status === "completed" &&
      input.now.getTime() - effect.updatedAt.getTime() <= APPROVAL_TARGET_LOOKBACK_MS &&
      (!completed || effect.updatedAt > completed.effect.updatedAt)
    ) {
      completed = { effect, args: details.args };
    }
  }
  return { pending, completed };
}

function describeTarget(target: ApprovalTarget): string {
  return Object.entries(target)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

function describeChange(args: Record<string, unknown>): string {
  const { reason: _reason, ...change } = args;
  const text = JSON.stringify(change);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

export function sameTargetPendingResult(target: ApprovalTarget) {
  return {
    error: `Not sent for approval: a change to the same target (${describeTarget(target)}) is already waiting for the person's answer. Do not file another card for it; wait for that answer, then check the live state before changing it again.`,
  };
}

export function sameTargetCompletedResult(target: ApprovalTarget, match: SameTargetMatch) {
  return {
    error: `Not sent for approval yet: this target (${describeTarget(target)}) was already changed at ${match.effect.updatedAt.toISOString()} with ${describeChange(match.args)}. Read the live state first; the earlier change may already be what was asked for. If a further change is really needed, call the tool again with exactly the same arguments and it will go to the person.`,
  };
}

/** One approval card per turn: sibling gated calls are told to wait instead of failing. */
export function approvalQueuedResult() {
  return {
    error:
      "Not sent for approval: another change from this step is already waiting for the person's answer, and only one card can wait at a time. Submit this change again after that card is answered.",
  };
}
