import { describe, expect, it } from "vitest";
import {
  durationMs,
  fieldRows,
  formatDuration,
  settingRows,
  splitList,
  swapsOf,
  taskQuery,
  taskSummary,
  type Task,
} from "./meili";

const task = (over: Partial<Task>): Task => ({
  uid: 1,
  indexUid: null,
  status: "succeeded",
  type: "indexSwap",
  duration: null,
  enqueuedAt: "2026-11-14T10:00:00Z",
  startedAt: null,
  finishedAt: null,
  ...over,
});

describe("meilisearch helpers", () => {
  it("builds task filters without empty values", () => {
    expect(taskQuery({})).toBe("/api/meili/tasks");
    expect(
      taskQuery({
        statuses: ["failed", "processing"],
        types: [""],
        indexUids: ["products"],
        limit: 20,
        from: 0,
      }),
    ).toBe(
      "/api/meili/tasks?statuses=failed%2Cprocessing&indexUids=products&limit=20&from=0",
    );
  });
  it("parses ISO durations", () => {
    expect(durationMs("PT0.012345S")).toBe(12);
    expect(durationMs("PT1M2.5S")).toBe(62500);
    expect(durationMs("P1DT1H")).toBe(90000000);
    expect(durationMs(null)).toBeNull();
    expect(durationMs("garbage")).toBeNull();
    expect(formatDuration(12, "en")).toBe("12 ms");
    expect(formatDuration(62500, "en")).toBe("1 min 3 s");
    expect(formatDuration(null, "en")).toBe("—");
  });
  it("reads index swaps, including renames", () => {
    const swaps = swapsOf([
      task({
        uid: 7,
        finishedAt: "2026-11-14T11:00:00Z",
        details: {
          swaps: [{ indexes: ["articles_v2", "articles"], rename: true }],
        },
      }),
      task({ uid: 8, details: { swaps: [{ indexes: ["a"] }] } }),
      task({ uid: 9, details: null }),
    ]);
    expect(swaps).toEqual([
      {
        task: 7,
        status: "succeeded",
        at: "2026-11-14T11:00:00Z",
        from: "articles_v2",
        to: "articles",
        rename: true,
      },
    ]);
  });
  it("summarises details, field distribution and settings", () => {
    expect(
      taskSummary(
        task({
          details: { receivedDocuments: 6, indexedDocuments: 6, x: null },
        }),
      ),
    ).toBe("receivedDocuments: 6 · indexedDocuments: 6");
    expect(fieldRows({ b: 2, a: 2, c: 5 })).toEqual([
      { field: "c", count: 5 },
      { field: "a", count: 2 },
      { field: "b", count: 2 },
    ]);
    const rows = settingRows({
      searchableAttributes: ["*"],
      stopWords: [],
      synonyms: { phone: ["mobile"] },
      typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 5 } },
      distinctAttribute: null,
    });
    expect(rows.map((r) => [r.key, r.kind, r.empty])).toEqual([
      ["searchableAttributes", "list", false],
      ["stopWords", "list", true],
      ["synonyms", "map", false],
      ["typoTolerance", "object", false],
      ["distinctAttribute", "value", true],
    ]);
    expect(splitList(" brand, ,category ")).toEqual(["brand", "category"]);
  });
});
