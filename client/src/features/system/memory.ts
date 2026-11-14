import type { Key } from "../../lib/i18n";

const TOP_APPS = 8;
export type Kind = "container" | "service" | "other";
export type AppGroup = {
  id: string;
  name: string;
  kind: Kind;
  project?: string;
  service?: string;
  memory: number;
  cache: number;
  limit: number | null;
  cpu: number | null;
};
export type SystemReport = {
  memory: {
    total: number;
    used: number;
    available: number;
    free: number;
    buffers: number;
    cached: number;
    swapTotal: number;
    swapUsed: number;
  };
  groups: AppGroup[];
  accounted: number;
  cgroupAvailable: boolean;
  sampledAt: string;
};
export type Segment = {
  key: string;
  label: string;
  bytes: number;
  tone: string;
};

export function formatBytes(bytes: number, locale: string) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit < 2 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: unit >= 3 ? Math.min(digits, 1) : 0 }).format(value)} ${units[unit]}`;
}

// Splits total RAM into app, unaccounted, cache and free parts that always sum
// to the total. Cache is capped by what is not in use so bars never overflow.
export function memorySegments(
  report: SystemReport,
  label: (key: Key) => string,
): Segment[] {
  const { total, used, cached } = report.memory;
  if (!total) return [];
  const apps = report.groups.slice(0, TOP_APPS);
  const rest = report.groups
    .slice(TOP_APPS)
    .reduce((sum, g) => sum + g.memory, 0);
  const segments: Segment[] = apps.map((g, i) => ({
    key: g.id,
    label: displayName(g, label),
    bytes: g.memory,
    tone: `app${i}`,
  }));
  if (rest > 0)
    segments.push({
      key: "other",
      label: label("otherApps"),
      bytes: rest,
      tone: "others",
    });
  const inUse = Math.min(total, Math.max(used, report.accounted));
  const unaccounted = Math.max(0, inUse - report.accounted);
  if (report.cgroupAvailable && unaccounted > 0)
    segments.push({
      key: "unaccounted",
      label: label("unaccounted"),
      bytes: unaccounted,
      tone: "kernel",
    });
  if (!report.cgroupAvailable)
    segments.push({
      key: "used",
      label: label("memUsed"),
      bytes: used,
      tone: "kernel",
    });
  const idle = Math.max(0, total - inUse);
  const cache = Math.min(cached, idle);
  segments.push(
    { key: "cache", label: label("memCache"), bytes: cache, tone: "cache" },
    {
      key: "free",
      label: label("freeMemory"),
      bytes: idle - cache,
      tone: "free",
    },
  );
  // Scale down if apps alone exceed total (should not happen; keeps widths sane).
  const sum = segments.reduce((s, x) => s + x.bytes, 0);
  return sum > total
    ? segments.map((x) => ({ ...x, bytes: (x.bytes * total) / sum }))
    : segments;
}

export function displayName(g: AppGroup, label: (key: Key) => string) {
  if (g.kind === "other" && g.id === "user.slice") return label("userSessions");
  if (g.kind === "other" && g.id === "init.scope") return label("initProcess");
  return g.name;
}
