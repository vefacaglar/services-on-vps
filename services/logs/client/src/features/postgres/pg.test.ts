import { describe, expect, it } from "vitest";
import {
  apiPath,
  errorLocation,
  formatUptime,
  quoteIdent,
  sortTables,
  starterQuery,
  tablePath,
  type TableRow,
} from "./pg";

const table = (schema: string, name: string, over: Partial<TableRow> = {}) =>
  ({
    schema,
    name,
    kind: "table",
    estimatedRows: 0,
    totalSize: 0,
    tableSize: 0,
    indexSize: 0,
    seqScans: null,
    idxScans: null,
    liveRows: null,
    deadRows: null,
    lastVacuum: null,
    lastAnalyze: null,
    readable: true,
    ...over,
  }) as TableRow;

describe("postgres helpers", () => {
  it("sorts and filters tables", () => {
    const rows = [
      table("public", "b", { totalSize: 10, estimatedRows: 5 }),
      table("public", "a", { totalSize: 30, estimatedRows: -1 }),
      table("audit", "log", { totalSize: 20, deadRows: 9 }),
    ];
    expect(sortTables(rows, "totalSize", true).map((t) => t.name)).toEqual([
      "a",
      "log",
      "b",
    ]);
    expect(sortTables(rows, "name", false).map((t) => t.name)).toEqual([
      "log",
      "a",
      "b",
    ]);
    expect(sortTables(rows, "deadRows", true)[0].name).toBe("log");
    expect(sortTables(rows, "name", false, "PUBLIC.").length).toBe(2);
  });
  it("escapes identifiers in paths and SQL", () => {
    expect(tablePath("my db", "Sales Data", 'We"ird/x')).toBe(
      "/postgres/db/my%20db/table/Sales%20Data/We%22ird%2Fx",
    );
    expect(apiPath("/postgres/db/a/table/s/t")).toBe("/api/pg/db/a/table/s/t");
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(starterQuery("public", 'x"y')).toBe(
      'SELECT *\nFROM "public"."x""y"\nLIMIT 100',
    );
  });
  it("formats uptime and error positions", () => {
    expect(formatUptime(90061, "en")).toBe("1 d 1 h");
    expect(formatUptime(3720, "tr")).toBe("1 sa 2 dk");
    expect(formatUptime(59, "en")).toBe("0 min");
    expect(errorLocation("SELECT\n  bad x", 12)).toEqual({
      line: 2,
      column: 5,
    });
    expect(errorLocation("SELECT 1", 0)).toBeNull();
  });
});
