import { describe, expect, it } from "vitest";
import { formatBytes, memorySegments, type SystemReport } from "./memory";
import { en, type Key } from "../../lib/i18n";

const GiB = 1024 ** 3,
  MiB = 1024 ** 2;
const label = (key: Key) => en[key];
function report(groups: number[], cgroupAvailable = true): SystemReport {
  const list = groups.map((memory, i) => ({
    id: `app${i}`,
    name: `app${i}`,
    kind: "container" as const,
    memory,
    cache: 0,
    limit: null,
    cpu: null,
  }));
  return {
    memory: {
      total: 8 * GiB,
      used: 3 * GiB,
      available: 5 * GiB,
      free: 1 * GiB,
      buffers: 0,
      cached: 3 * GiB,
      swapTotal: 0,
      swapUsed: 0,
    },
    groups: cgroupAvailable ? list : [],
    accounted: cgroupAvailable ? groups.reduce((a, b) => a + b, 0) : 0,
    cgroupAvailable,
    sampledAt: "2026-11-14T00:00:00Z",
  };
}

describe("system memory", () => {
  it("formats sizes with binary units and locale decimals", () => {
    expect(formatBytes(512 * MiB, "en-GB")).toBe("512 MiB");
    expect(formatBytes(7.5 * GiB, "tr-TR")).toBe("7,5 GiB");
    expect(formatBytes(900, "en-GB")).toBe("900 B");
  });
  it("splits total RAM into top apps, other apps, kernel, cache and free", () => {
    const segments = memorySegments(
      report([...Array(10)].map(() => 200 * MiB)),
      label,
    );
    expect(segments.map((s) => s.key)).toEqual([
      "app0",
      "app1",
      "app2",
      "app3",
      "app4",
      "app5",
      "app6",
      "app7",
      "other",
      "unaccounted",
      "cache",
      "free",
    ]);
    expect(segments.find((s) => s.key === "other")!.bytes).toBe(400 * MiB);
    expect(segments.find((s) => s.key === "unaccounted")!.bytes).toBe(
      3 * GiB - 2000 * MiB,
    );
    expect(segments.find((s) => s.key === "cache")!.bytes).toBe(3 * GiB);
    expect(segments.reduce((sum, s) => sum + s.bytes, 0)).toBe(8 * GiB);
  });
  it("falls back to used memory when per-app data is unavailable", () => {
    const segments = memorySegments(report([], false), label);
    expect(segments.map((s) => s.key)).toEqual(["used", "cache", "free"]);
    expect(segments.reduce((sum, s) => sum + s.bytes, 0)).toBe(8 * GiB);
  });
});
