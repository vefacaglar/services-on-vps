import { describe, expect, it } from "vitest";
import {
  columnCompletions,
  completionNamespace,
  referencedTables,
  type DbSchema,
} from "./sqlCompletion";

const schema: DbSchema = {
  truncated: false,
  schemas: {
    public: {
      products: [
        { name: "id", type: "integer" },
        { name: "name", type: "text" },
      ],
      orders: [
        { name: "id", type: "bigint" },
        { name: "product_id", type: "integer" },
      ],
    },
    "Sales Data": { 'We"ird': [{ name: "val ue", type: "text" }] },
    audit: { log: [{ name: "at", type: "timestamp with time zone" }] },
  },
};

describe("sql completion", () => {
  it("maps the schema to a typed completion namespace", () => {
    const ns = completionNamespace(schema);
    expect(Object.keys(ns)).toEqual(["public", "Sales Data", "audit"]);
    expect(ns.public.products).toEqual([
      { label: "id", type: "property", detail: "integer" },
      { label: "name", type: "property", detail: "text" },
    ]);
    expect(ns["Sales Data"]['We"ird'][0].label).toBe("val ue");
    expect(completionNamespace(undefined)).toEqual({});
  });
  it("finds referenced tables, quoted and qualified", () => {
    expect(
      referencedTables(
        "SELECT * FROM products p JOIN public.orders o ON o.product_id = p.id",
        schema,
      ),
    ).toEqual([
      { schema: "public", table: "products" },
      { schema: "public", table: "orders" },
    ]);
    expect(
      referencedTables('select 1 from "Sales Data"."We""ird"', schema),
    ).toEqual([{ schema: "Sales Data", table: 'We"ird' }]);
    expect(referencedTables("UPDATE log SET at = now()", schema)).toEqual([
      { schema: "audit", table: "log" },
    ]);
    expect(
      referencedTables("SELECT 'from products' -- join orders", schema),
    ).toEqual([]);
    expect(referencedTables("SELECT * FROM nope", schema)).toEqual([]);
  });
  it("offers columns of the FROM tables without duplicates", () => {
    const items = columnCompletions(
      "SELECT  FROM products JOIN orders ON true",
      schema,
    );
    expect(items.map((i) => i.label)).toEqual(["id", "name", "product_id"]);
    expect(items[0].detail).toBe("products · integer");
    expect(columnCompletions("SELECT ", schema)).toEqual([]);
  });
});
