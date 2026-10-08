import { describe, expect, it } from "vitest";
import { boundDirectApprovalRequest } from "./approval-effect.js";
import {
  APPROVAL_TARGET_LOOKBACK_MS,
  approvalTargetKeysFromMeta,
  approvalTargetOf,
  findSameTargetEffect,
  type PriorEffect,
} from "./approval-target.js";

const MARKER = "__marker";
const route = { connectorId: "installed", resourceId: "res-1", toolName: "update_widget" };
const now = new Date("2026-10-08T18:00:00Z");

function effect(
  id: string,
  status: string,
  args: Record<string, unknown>,
  at = now,
  effectRoute = route,
): PriorEffect {
  return {
    id,
    status,
    request: boundDirectApprovalRequest(effectRoute, args, MARKER),
    createdAt: at,
    updatedAt: at,
  };
}

describe("approvalTargetKeysFromMeta", () => {
  it("reads a list of argument names", () => {
    expect(
      approvalTargetKeysFromMeta({ "rakazo/approvalTarget": ["post_id", "widget_id"] }),
    ).toEqual(["post_id", "widget_id"]);
  });

  it.each([
    undefined,
    {},
    { "rakazo/approvalTarget": [] },
    { "rakazo/approvalTarget": [1] },
    {
      "rakazo/approvalTarget": "post_id",
    },
  ])("ignores %j", (meta) => {
    expect(approvalTargetKeysFromMeta(meta)).toBeUndefined();
  });
});

describe("approvalTargetOf", () => {
  it("keeps scalar values and marks missing keys", () => {
    expect(
      approvalTargetOf({ target: "post_content", post_id: 3 }, ["target", "post_id", "key"]),
    ).toEqual({ target: "post_content", post_id: 3, key: null });
  });

  it("has no target when no key is set or a value is not scalar", () => {
    expect(approvalTargetOf({ title: "New post" }, ["post_id"])).toBeUndefined();
    expect(approvalTargetOf({ post_id: { id: 3 } }, ["post_id"])).toBeUndefined();
  });
});

describe("findSameTargetEffect", () => {
  const target = { post_id: 38, widget_id: "785fffa" };
  const find = (effects: PriorEffect[]) =>
    findSameTargetEffect({ effects, target, route, marker: MARKER, now });

  it("prefers a waiting card over a finished change", () => {
    const result = find([
      effect("done", "completed", { post_id: 38, widget_id: "785fffa", settings: {} }),
      effect("waiting", "intended", { post_id: "38", widget_id: "785fffa", settings: {} }),
    ]);
    expect(result.pending?.effect.id).toBe("waiting");
    expect(result.completed?.effect.id).toBe("done");
  });

  it("ignores other targets, other tools, denied cards and old changes", () => {
    const old = new Date(now.getTime() - APPROVAL_TARGET_LOOKBACK_MS - 1);
    expect(
      find([
        effect("other-widget", "intended", { post_id: 38, widget_id: "ac3d3f7" }),
        effect("other-tool", "intended", target, now, { ...route, toolName: "replace_text" }),
        effect("denied", "denied", target),
        effect("old", "completed", target, old),
        { ...effect("plain", "intended", target), request: target },
      ]),
    ).toEqual({ pending: undefined, completed: undefined });
  });
});
