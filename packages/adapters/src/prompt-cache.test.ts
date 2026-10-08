import { describe, expect, it } from "vitest";
import {
  markStableHistoryBreakpoint,
  stablePrefixTtlFromEnv,
  withStableHistoryCache,
} from "./prompt-cache.js";

const ephemeral = { type: "ephemeral" };

function payload(messages: Array<{ role: string; content: unknown }>, extra = {}) {
  return {
    tools: [{ name: "a" }, { name: "b", cache_control: { ...ephemeral } }],
    system: [{ type: "text", text: "system", cache_control: { ...ephemeral } }],
    messages,
    ...extra,
  };
}

function lastPrompt(text = "new prompt") {
  return { role: "user", content: [{ type: "text", text, cache_control: { ...ephemeral } }] };
}

const history = [
  { role: "user", content: "first" },
  { role: "user", content: "Assistant: reply" },
];

describe("markStableHistoryBreakpoint", () => {
  it("marks the last history message so the next run can read the history from cache", () => {
    const body = payload([
      { role: "user", content: "first" },
      { role: "user", content: "Assistant: reply" },
      lastPrompt(),
    ]);
    markStableHistoryBreakpoint(body, history);
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Assistant: reply", cache_control: ephemeral }],
    });
    expect(body.messages[0]).toEqual({ role: "user", content: "first" });
  });

  it("keeps the breakpoint in place on later calls of the same run", () => {
    const body = payload([
      { role: "user", content: "first" },
      { role: "user", content: "Assistant: reply" },
      { role: "user", content: [{ type: "text", text: "new prompt" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", cache_control: { ...ephemeral } }],
      },
    ]);
    markStableHistoryBreakpoint(body, history);
    expect(body.messages[1]!.content).toEqual([
      { type: "text", text: "Assistant: reply", cache_control: ephemeral },
    ]);
  });

  it("skips empty history messages exactly as pi does when it builds the request", () => {
    const body = payload([
      { role: "user", content: "first" },
      { role: "user", content: "Assistant: reply" },
      lastPrompt(),
    ]);
    markStableHistoryBreakpoint(body, [history[0]!, { role: "user", content: "  " }, history[1]!]);
    expect(Array.isArray(body.messages[1]!.content)).toBe(true);
  });

  it("marks the last block of a message with images", () => {
    const withImage = {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "x" },
      ],
    };
    const body = payload([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: {} },
        ],
      },
      lastPrompt(),
    ]);
    markStableHistoryBreakpoint(body, [withImage]);
    expect(body.messages[0]!.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: {}, cache_control: ephemeral },
    ]);
  });

  it("leaves the payload alone when the history does not line up", () => {
    const body = payload([{ role: "user", content: "something else" }, lastPrompt()]);
    const before = JSON.stringify(body);
    markStableHistoryBreakpoint(body, [{ role: "user", content: "first" }]);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("never exceeds Anthropic's four breakpoints (OAuth requests already use four)", () => {
    const body = payload([{ role: "user", content: "first" }, lastPrompt()], {
      system: [
        { type: "text", text: "identity", cache_control: { ...ephemeral } },
        { type: "text", text: "system", cache_control: { ...ephemeral } },
      ],
    });
    markStableHistoryBreakpoint(body, [{ role: "user", content: "first" }]);
    expect(body.messages[0]).toEqual({ role: "user", content: "first" });
  });

  it("adds nothing when caching is turned off", () => {
    const body = {
      tools: [{ name: "a" }],
      system: [{ type: "text", text: "system" }],
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: [{ type: "text", text: "new prompt" }] },
      ],
    };
    markStableHistoryBreakpoint(body, [{ role: "user", content: "first" }]);
    expect(body.messages[0]).toEqual({ role: "user", content: "first" });
  });

  it("adds nothing when there is no history or nothing after it", () => {
    const body = payload([{ role: "user", content: "first" }]);
    markStableHistoryBreakpoint(body, [{ role: "user", content: "first" }]);
    expect(body.messages[0]).toEqual({ role: "user", content: "first" });
    const empty = payload([lastPrompt()]);
    markStableHistoryBreakpoint(empty, []);
    expect(empty.messages).toHaveLength(1);
  });

  it("with a 1h stable TTL extends tools, system and history but not the moving last message", () => {
    const body = payload([{ role: "user", content: "first" }, lastPrompt()]);
    markStableHistoryBreakpoint(body, [{ role: "user", content: "first" }], { stableTtl: "1h" });
    const long = { type: "ephemeral", ttl: "1h" };
    expect(body.tools[1]!.cache_control).toEqual(long);
    expect(body.system[0]!.cache_control).toEqual(long);
    expect(body.messages[0]!.content).toEqual([
      { type: "text", text: "first", cache_control: long },
    ]);
    expect(body.messages[1]!.content).toEqual([
      { type: "text", text: "new prompt", cache_control: ephemeral },
    ]);
  });
});

describe("stablePrefixTtlFromEnv", () => {
  it("reads only the exact 1h value", () => {
    expect(stablePrefixTtlFromEnv({ PROMPT_CACHE_STABLE_TTL: "1h" })).toBe("1h");
    expect(stablePrefixTtlFromEnv({ PROMPT_CACHE_STABLE_TTL: "5m" })).toBeUndefined();
    expect(stablePrefixTtlFromEnv({})).toBeUndefined();
  });
});

describe("withStableHistoryCache", () => {
  it("only hooks Anthropic Messages requests", () => {
    const options = { maxTokens: 1 };
    expect(withStableHistoryCache(options, { api: "openai-completions" }, history)).toBe(options);
    expect(withStableHistoryCache(options, { api: "anthropic-messages" }, [])).toBe(options);
  });

  it("marks the payload before the caller's own hook sees it", async () => {
    const seen: unknown[] = [];
    const options = withStableHistoryCache(
      {
        onPayload: (body: unknown) => {
          seen.push(JSON.parse(JSON.stringify(body)));
          return undefined;
        },
      },
      { api: "anthropic-messages" },
      history,
      undefined,
    );
    const body = payload([
      { role: "user", content: "first" },
      { role: "user", content: "Assistant: reply" },
      lastPrompt(),
    ]);
    const hook = (options as { onPayload: (payload: unknown, model: never) => unknown }).onPayload;
    const result = await hook(body, undefined as never);
    expect(result).toBe(body);
    expect((seen[0] as typeof body).messages[1]!.content).toEqual([
      { type: "text", text: "Assistant: reply", cache_control: ephemeral },
    ]);
  });
});
