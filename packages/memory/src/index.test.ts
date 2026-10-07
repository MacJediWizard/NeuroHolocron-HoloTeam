import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const context: AdapterContext = {
  operationId: "read-memory",
  traceId: "read-memory",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("memory store contract shape", () => {
  it("declares markdown portability", () => {
    const store = new MarkdownMemoryStore({} as never);
    expect(store.describe().capabilities.markdownPortable).toBe(true);
  });

  it("reads the most recently updated documents first", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "memory-1", path: "facts.md", content: "A fact", revision: 3, updatedAt },
      ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        scope: "bot",
        botId: "bot-1",
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
  });

  it("keeps user memory personal while bot memory is shared by the Space", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await store.read({ scope: "user" }, context);
    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      spaceId: "workspace-1",
      userId: "user-1",
      scope: "user",
    });

    await store.search({ query: "x", scope: "all" }, context);
    expect(findMany.mock.calls[1]?.[0].where).toEqual({
      spaceId: "workspace-1",
      OR: [{ scope: { not: "user" } }, { scope: "user", userId: "user-1" }],
    });

    await store.search({ query: "x", scope: "bot", botId: "bot-1" }, context);
    expect(findMany.mock.calls[2]?.[0].where).toEqual({
      spaceId: "workspace-1",
      scope: "bot",
      botId: "bot-1",
    });
  });
});
