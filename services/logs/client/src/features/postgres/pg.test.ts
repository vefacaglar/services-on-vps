import { describe, expect, it } from "vitest";
import {
  WORKSPACE_KEY,
  apiPath,
  cellCopy,
  confirmMatches,
  errorRange,
  loadWorkspace,
  newTab,
  planLines,
  rowCopy,
  saveWorkspace,
  selectTop,
  sortRows,
  sqlIdent,
  sqlName,
  describeKey,
  editText,
  insertValues,
  isTruncated,
  pgArrayLiteral,
  rowKey,
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

describe("write mode helpers", () => {
  it("requires the exact database name", () => {
    expect(confirmMatches(" shop ", "shop")).toBe(true);
    expect(confirmMatches("Shop", "shop")).toBe(false);
    expect(confirmMatches("", "shop")).toBe(false);
  });
  it("detects shortened values", () => {
    expect(isTruncated("a".repeat(2000) + "…")).toBe(true);
    expect(isTruncated("ç".repeat(999) + "…")).toBe(true);
    expect(isTruncated("short…")).toBe(false);
    expect(isTruncated(42)).toBe(false);
  });
  it("builds primary keys only when every value is usable", () => {
    expect(rowKey({ id: 7, name: "x" }, ["id"])).toEqual({ id: 7 });
    expect(rowKey({ a: "1", b: 2 }, ["a", "b"])).toEqual({ a: "1", b: 2 });
    expect(rowKey({ id: 7 }, [])).toBeNull();
    expect(rowKey({ id: null }, ["id"])).toBeNull();
    expect(rowKey({ name: "x" }, ["id"])).toBeNull();
    expect(rowKey({ id: { a: 1 } }, ["id"])).toBeNull();
    expect(rowKey({ id: "x".repeat(2000) + "…" }, ["id"])).toBeNull();
  });
  it("turns cells into PostgreSQL input text", () => {
    expect(editText(null, "text")).toBe("");
    expect(editText("16.50", "numeric")).toBe("16.50");
    expect(editText(42, "integer")).toBe("42");
    expect(editText(true, "boolean")).toBe("true");
    expect(editText({ a: [1] }, "jsonb")).toBe('{"a":[1]}');
    expect(editText(["a", 'b"c', null], "text[]")).toBe('{"a","b\\"c",NULL}');
    expect(editText([[1, 2]], "integer[]")).toBe('{{"1","2"}}');
    expect(editText([1, 2], "jsonb")).toBe("[1,2]");
    expect(pgArrayLiteral(["back\\slash"])).toBe('{"back\\\\slash"}');
  });
  it("describes keys and collects insert values", () => {
    expect(describeKey({ id: 7, code: "a" })).toBe("id = 7, code = a");
    expect(
      insertValues({
        id: { text: "", isNull: false },
        name: { text: "x", isNull: false },
        note: { text: "ignored", isNull: true },
      }),
    ).toEqual({ name: "x", note: null });
  });
});

describe("workspace helpers", () => {
  const memory = () => {
    const data: Record<string, string> = {};
    return {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
  };
  it("persists tabs and survives bad storage", () => {
    const store = memory();
    const first = loadWorkspace("shop", store);
    expect(first.tabs).toHaveLength(1);
    expect(first.tabs[0].db).toBe("shop");
    const second = newTab("other", "SELECT 2", first.tabs);
    expect(second.title).toBe("Query 2");
    saveWorkspace({ tabs: [...first.tabs, second], active: second.id }, store);
    const again = loadWorkspace("ignored", store);
    expect(again.active).toBe(second.id);
    expect(again.tabs.map((t) => t.db)).toEqual(["shop", "other"]);
    store.setItem(WORKSPACE_KEY, "{not json");
    expect(loadWorkspace("x", store).tabs[0].db).toBe("x");
    store.setItem(WORKSPACE_KEY, JSON.stringify({ tabs: [{ id: 1 }], active: 1 }));
    expect(loadWorkspace("y", store).tabs[0].db).toBe("y");
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadWorkspace("z", throwing).tabs[0].db).toBe("z");
    expect(() => saveWorkspace(again, throwing)).not.toThrow();
  });
  it("maps error positions into the document", () => {
    const doc = "SELECT 1;\nSELECT nosuch FROM t";
    expect(errorRange(doc, { from: 10, text: "SELECT nosuch FROM t" }, 8)).toEqual({
      from: 17,
      to: 23,
    });
    expect(errorRange("SELECT 'ç' + bad", { from: 0, text: "SELECT 'ç' + bad" }, 14)).toEqual({
      from: 13,
      to: 16,
    });
    expect(errorRange(doc, { from: 0, text: doc }, 0)).toBeNull();
  });
  it("keeps plan indentation and sorts results", () => {
    expect(
      planLines({
        columns: [{ name: "QUERY PLAN", type: "text" }],
        rows: [{ "QUERY PLAN": "Hash Join" }, { "QUERY PLAN": "  ->  Seq Scan" }],
        truncated: false,
        durationMs: 1,
      }),
    ).toEqual(["Hash Join", "  ->  Seq Scan"]);
    expect(
      planLines({ columns: [{ name: "a", type: "int4" }], rows: [], truncated: false, durationMs: 1 }),
    ).toBeNull();
    const rows = [{ v: "10" }, { v: null }, { v: "9" }, { v: 100 }];
    expect(sortRows(rows, "v", false).map((r) => r.v)).toEqual(["9", "10", 100, null]);
    expect(sortRows(rows, "v", true).map((r) => r.v)).toEqual([100, "10", "9", null]);
    expect(sortRows([{ v: "b" }, { v: "a" }], "v", false).map((r) => r.v)).toEqual(["a", "b"]);
  });
  it("copies cells with NULL kept distinct", () => {
    expect(cellCopy(null)).toBe("NULL");
    expect(cellCopy("")).toBe("");
    expect(cellCopy({ a: 1 })).toBe('{"a":1}');
    expect(rowCopy({ a: 1, b: null, c: "x" }, ["a", "b", "c"])).toBe("1\tNULL\tx");
  });
});

describe("explorer names", () => {
  it("quotes identifiers only when needed", () => {
    expect(sqlIdent("users")).toBe("users");
    expect(sqlIdent("Users")).toBe('"Users"');
    expect(sqlIdent("order")).toBe('"order"');
    expect(sqlIdent("val ue")).toBe('"val ue"');
    expect(sqlName("public", "users")).toBe("users");
    expect(sqlName("Sales Data", 'We"ird')).toBe('"Sales Data"."We""ird"');
    expect(selectTop("audit", "log")).toBe("SELECT *\nFROM audit.log\nLIMIT 100;");
  });
});
