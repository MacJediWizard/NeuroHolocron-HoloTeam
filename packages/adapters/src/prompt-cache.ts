/**
 * Anthropic prompt caching for the history a run starts with.
 *
 * Pi places cache breakpoints on the tools, the system prompt, and the last message only. The
 * first request of a run therefore ends its cacheable prefix at the new prompt, and the next run
 * (whose history now contains that prompt in a different form) can only reuse tools + system.
 * A breakpoint on the last message of the stable history lets the next run read everything up to
 * there and write only what is new.
 */

/** Anthropic rejects a request with more than four cache breakpoints. */
const MAX_CACHE_BREAKPOINTS = 4;

export type StablePrefixTtl = "1h";

type CacheControl = { type: "ephemeral"; ttl?: string };
type Block = { type?: string; text?: string; cache_control?: CacheControl };
type PayloadMessage = { role?: string; content?: string | Block[] };
type AnthropicPayload = {
  tools?: Block[];
  system?: string | Block[];
  messages?: PayloadMessage[];
};

/** A history message as handed to pi: plain text or text-and-image parts. */
export type StableHistoryMessage = {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function blocks(value: unknown): Block[] {
  return Array.isArray(value) ? (value.filter(isRecord) as Block[]) : [];
}

function countBreakpoints(payload: AnthropicPayload): number {
  let count = 0;
  for (const block of blocks(payload.tools)) if (block.cache_control) count += 1;
  for (const block of blocks(payload.system)) if (block.cache_control) count += 1;
  for (const message of payload.messages ?? []) {
    for (const block of blocks(message.content)) if (block.cache_control) count += 1;
  }
  return count;
}

function lastText(content: StableHistoryMessage["content"] | PayloadMessage["content"]) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const part = content[index];
    if (part?.type === "text") return part.text;
  }
  return undefined;
}

/** Pi drops empty text-only user messages, so they have no position on the wire. */
function sentToProvider(message: StableHistoryMessage): boolean {
  return typeof message.content !== "string" || message.content.trim().length > 0;
}

function withLongTtl(block: Block): void {
  if (block.cache_control) block.cache_control = { ...block.cache_control, ttl: "1h" };
}

/**
 * Adds a breakpoint at the end of the stable history in an Anthropic Messages payload, and, with
 * `stableTtl: "1h"`, keeps the tools, system and history breakpoints for an hour while the moving
 * last-message breakpoint keeps the default five minutes (the cheaper write for in-run calls).
 * Returns the payload unchanged when the history cannot be located exactly or the breakpoint
 * budget is used up, so a mismatch costs a cache miss, never a rejected request.
 */
export function markStableHistoryBreakpoint(
  payload: unknown,
  history: StableHistoryMessage[],
  options: { stableTtl?: StablePrefixTtl } = {},
): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
  const params = payload as AnthropicPayload;
  const messages = params.messages!;
  const sent = history.filter(sentToProvider);
  const stableCount = sent.length;
  // Only the first stableCount messages are history; a breakpoint is useful only when something
  // (the prompt and the run's own turns) follows it.
  if (stableCount === 0 || messages.length <= stableCount) return payload;

  const target = messages[stableCount - 1];
  const expected = lastText(sent[stableCount - 1]!.content);
  if (target?.role !== "user" || expected === undefined) return payload;
  if (typeof target.content === "string") {
    if (target.content !== expected) return payload;
  } else if (lastText(target.content) !== expected) {
    return payload;
  }

  // Follow pi's own decision: caching turned off means no breakpoints anywhere.
  if (countBreakpoints(params) === 0) return payload;

  const alreadyMarked = blocks(target.content).some((block) => block.cache_control);
  if (!alreadyMarked) {
    if (countBreakpoints(params) >= MAX_CACHE_BREAKPOINTS) return payload;
    const control: CacheControl = { type: "ephemeral" };
    if (typeof target.content === "string") {
      target.content = [{ type: "text", text: target.content, cache_control: control }];
    } else {
      const parts = target.content!;
      // Anthropic caches through the marked block, so mark the message's last block.
      parts[parts.length - 1] = { ...parts[parts.length - 1]!, cache_control: control };
    }
  }

  if (options.stableTtl === "1h") {
    // Longer-lived breakpoints must precede shorter ones: tools, system, then history.
    for (const block of blocks(params.tools)) withLongTtl(block);
    for (const block of blocks(params.system)) withLongTtl(block);
    for (const block of blocks(target.content)) withLongTtl(block);
  }
  return payload;
}

/** `PROMPT_CACHE_STABLE_TTL=1h` keeps the stable prefix cached for an hour between runs. */
export function stablePrefixTtlFromEnv(
  env: Record<string, string | undefined> = process.env,
): StablePrefixTtl | undefined {
  return env.PROMPT_CACHE_STABLE_TTL?.trim() === "1h" ? "1h" : undefined;
}

type PayloadHook = (payload: unknown, model: never) => unknown;

/**
 * Stream options for a run whose context starts with `history`: Anthropic Messages requests get
 * the stable-history breakpoint before any caller-supplied payload hook runs.
 */
export function withStableHistoryCache<T extends object | undefined>(
  options: T,
  model: { api: string },
  history: StableHistoryMessage[],
  stableTtl: StablePrefixTtl | undefined = stablePrefixTtlFromEnv(),
): T {
  if (model.api !== "anthropic-messages" || history.length === 0) return options;
  const callerHook = (options as { onPayload?: PayloadHook } | undefined)?.onPayload;
  return {
    ...options,
    onPayload: async (payload: unknown, requestModel: never) => {
      const marked = markStableHistoryBreakpoint(payload, history, { stableTtl });
      return callerHook ? ((await callerHook(marked, requestModel)) ?? marked) : marked;
    },
  } as T;
}
