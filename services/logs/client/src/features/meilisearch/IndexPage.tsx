import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState, type CSSProperties, type FormEvent } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import { JSONView, TableView } from "../../components/LogViews";
import { api } from "../../lib/api";
import {
  fieldRows,
  settingRows,
  splitList,
  UID,
  type DocumentPage,
  type IndexDetail,
  type SearchResult,
  type SettingRow,
} from "./meili";
import { MeiliError, MeiliHeading, RefreshButton, useFormat } from "./shared";
import styles from "./Meilisearch.module.css";

const tabs = ["documents", "settings", "stats"] as const;
type Tab = (typeof tabs)[number];
const tabLabels = {
  documents: "tabDocuments",
  settings: "tabSettings",
  stats: "tabStats",
} as const;
const PAGE = 20;

export default function IndexPage() {
  const { uid = "" } = useParams();
  const { t } = usePreferences();
  const f = useFormat();
  const [params, setParams] = useSearchParams();
  const tab: Tab = tabs.find((x) => x === params.get("tab")) || "documents";
  const detail = useQuery({
    queryKey: ["meili", "index", uid],
    queryFn: ({ signal }) =>
      api<IndexDetail>(
        `/api/meili/indexes/${encodeURIComponent(uid)}`,
        undefined,
        signal,
      ),
    enabled: UID.test(uid),
    retry: false,
  });
  if (!UID.test(uid)) return <Navigate replace to="/meilisearch" />;
  const data = detail.data;
  return (
    <>
      <MeiliHeading
        title={uid}
        eyebrow={
          data
            ? `${t("meiliIndex")} · ${t("primaryKey")}: ${data.index.primaryKey || "—"} · ${t("updated")} ${f.date(data.index.updatedAt)}`
            : t("meiliIndex")
        }
      >
        <Link to="/meilisearch" className={styles.back}>
          ← {t("backToMeili")}
        </Link>
        <RefreshButton
          busy={detail.isFetching}
          onClick={() => void detail.refetch()}
        />
      </MeiliHeading>
      <MeiliError error={detail.error} />
      {detail.isPending && <p className={styles.meta}>{t("loading")}</p>}
      {data && (
        <div className={styles.page}>
          <div role="tablist" aria-label={uid} className={styles.tabs}>
            {tabs.map((item) => (
              <button
                key={item}
                role="tab"
                aria-selected={tab === item}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("tab", item);
                  setParams(next, { replace: true });
                }}
              >
                {t(tabLabels[item])}
              </button>
            ))}
          </div>
          {tab === "documents" && <Documents uid={uid} />}
          {tab === "settings" && <Settings settings={data.settings} />}
          {tab === "stats" && <Stats detail={data} />}
        </div>
      )}
    </>
  );
}

type Search = { q: string; filter: string; sort: string; facets: string };
const blank: Search = { q: "", filter: "", sort: "", facets: "" };

function Documents({ uid }: { uid: string }) {
  const { t } = usePreferences();
  const f = useFormat();
  const [draft, setDraft] = useState<Search>(blank);
  const [search, setSearch] = useState<Search>(blank);
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<"table" | "json">("table");
  const [wrap, setWrap] = useState(false);
  // Plain browsing (optionally filtered) uses /documents for an exact total;
  // a query, sort or facets switches to /search.
  const searching = !!(
    search.q.trim() ||
    search.sort.trim() ||
    search.facets.trim()
  );
  const base = `/api/meili/indexes/${encodeURIComponent(uid)}`;
  const result = useQuery({
    queryKey: ["meili", "docs", uid, search, offset],
    queryFn: async ({ signal }) => {
      if (searching) {
        const r = await api<SearchResult>(
          `${base}/search`,
          {
            q: search.q,
            filter: search.filter,
            sort: splitList(search.sort),
            facets: splitList(search.facets),
            limit: PAGE,
            offset,
          },
          signal,
        );
        return {
          rows: r.hits,
          total: r.estimatedTotalHits ?? r.totalHits ?? r.hits.length,
          ms: r.processingTimeMs,
          facets: r.facetDistribution,
        };
      }
      const query = new URLSearchParams({
        limit: String(PAGE),
        offset: String(offset),
      });
      if (search.filter.trim()) query.set("filter", search.filter.trim());
      const r = await api<DocumentPage>(
        `${base}/documents?${query}`,
        undefined,
        signal,
      );
      return { rows: r.results, total: r.total, ms: null, facets: undefined };
    },
    retry: false,
    placeholderData: keepPreviousData,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    setSearch(draft);
    setOffset(0);
  }
  const data = result.data;
  const field = (key: keyof Search, label: string, placeholder: string) => (
    <label className={key === "q" ? styles.wide : undefined}>
      <span>{label}</span>
      <input
        value={draft[key]}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <>
      <form className={styles.searchForm} onSubmit={submit} role="search">
        {field("q", t("searchQuery"), t("searchPlaceholderMeili"))}
        {field("filter", t("filterExpr"), t("filterPlaceholder"))}
        {field("sort", t("sortExpr"), t("sortPlaceholder"))}
        {field("facets", t("facets"), t("facetsPlaceholder"))}
        <div className={styles.formActions}>
          <button className="primary" type="submit">
            {t("search")} ↵
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setDraft(blank);
              setSearch(blank);
              setOffset(0);
            }}
          >
            {t("clearFilters")}
          </button>
        </div>
        <p className={styles.help}>{t("searchHelp")}</p>
      </form>
      <MeiliError error={result.error} />
      <section className={styles.results}>
        <div className={styles.resultHeader}>
          <div role="tablist" aria-label={t("rows")} className={styles.tabs}>
            {(["table", "json"] as const).map((item) => (
              <button
                key={item}
                role="tab"
                aria-selected={view === item}
                onClick={() => setView(item)}
              >
                {t(item)}
              </button>
            ))}
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(e) => setWrap(e.target.checked)}
            />
            {t("wrapLines")}
          </label>
        </div>
        <p className={styles.meta} role="status">
          {result.isFetching
            ? t("loading")
            : data
              ? data.rows.length
                ? data.ms != null
                  ? `${f.number(offset + 1)}–${f.number(offset + data.rows.length)} · ${t("hitsInfo", { total: f.number(data.total), ms: data.ms })}`
                  : t("pageInfo", {
                      from: f.number(offset + 1),
                      to: f.number(offset + data.rows.length),
                      total: f.number(data.total),
                    })
                : ""
              : ""}
        </p>
        {data && data.rows.length === 0 && (
          <div className="empty">
            <p>{t("noDocuments")}</p>
          </div>
        )}
        {data &&
          data.rows.length > 0 &&
          (view === "table" ? (
            <TableView rows={data.rows} wrap={wrap} />
          ) : (
            <JSONView rows={data.rows} wrap={wrap} />
          ))}
        {data && (
          <div className={styles.pager}>
            <button
              className="ghost"
              disabled={offset === 0 || result.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              ← {t("previous")}
            </button>
            <button
              className="ghost"
              disabled={offset + PAGE >= data.total || result.isFetching}
              onClick={() => setOffset(offset + PAGE)}
            >
              {t("next")} →
            </button>
          </div>
        )}
        {data?.facets && Object.keys(data.facets).length > 0 && (
          <section className={styles.card}>
            <div className={styles.heading}>
              <h2>{t("facets")}</h2>
            </div>
            <div className={styles.facets}>
              {Object.entries(data.facets).map(([name, values]) => (
                <div key={name}>
                  <h3>
                    <code>{name}</code>
                  </h3>
                  <ul>
                    {Object.entries(values).map(([value, count]) => (
                      <li key={value}>
                        <span>{value}</span>
                        <span className={styles.number}>{f.number(count)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}
      </section>
    </>
  );
}

function SettingValue({ row }: { row: SettingRow }) {
  const { t } = usePreferences();
  if (row.empty) return <span className={styles.muted}>{t("notSet")}</span>;
  if (row.kind === "list")
    return (
      <ul className={styles.chips}>
        {(row.value as unknown[]).map((item, i) => (
          <li key={i}>
            <code>
              {typeof item === "string" ? item : JSON.stringify(item)}
            </code>
          </li>
        ))}
      </ul>
    );
  if (row.kind === "map")
    return (
      <dl className={styles.map}>
        {Object.entries(row.value as Record<string, unknown>).map(([k, v]) => (
          <div key={k}>
            <dt>
              <code>{k}</code>
            </dt>
            <dd>
              {Array.isArray(v) ? v.join(", ") : v == null ? "—" : String(v)}
            </dd>
          </div>
        ))}
      </dl>
    );
  if (row.kind === "object")
    return (
      <pre className={styles.code}>{JSON.stringify(row.value, null, 2)}</pre>
    );
  return <code>{String(row.value)}</code>;
}

function Settings({ settings }: { settings: Record<string, unknown> }) {
  const rows = settingRows(settings);
  return (
    <section className={styles.card}>
      <dl className={styles.settings}>
        {rows.map((row) => (
          <div key={row.key}>
            <dt>{row.key}</dt>
            <dd>
              <SettingValue row={row} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Stats({ detail }: { detail: IndexDetail }) {
  const { t } = usePreferences();
  const f = useFormat();
  const s = detail.stats;
  const fields = fieldRows(s.fieldDistribution);
  const total = s.numberOfDocuments || 0;
  return (
    <>
      <section className={styles.card}>
        <dl className={styles.stats}>
          <div>
            <dt>{t("documents")}</dt>
            <dd>{f.number(s.numberOfDocuments)}</dd>
          </div>
          <div>
            <dt>{t("size")}</dt>
            <dd>{f.bytes(s.rawDocumentDbSize)}</dd>
          </div>
          <div>
            <dt>{t("avgDocSize")}</dt>
            <dd>{f.bytes(s.avgDocumentSize)}</dd>
          </div>
          <div>
            <dt>{t("embeddedDocs")}</dt>
            <dd>{f.number(s.numberOfEmbeddedDocuments ?? 0)}</dd>
          </div>
          <div>
            <dt>{t("status")}</dt>
            <dd className={styles.small}>
              {t(s.isIndexing ? "indexing" : "indexReady")}
            </dd>
          </div>
        </dl>
      </section>
      <section className={styles.card}>
        <div className={styles.heading}>
          <h2>{t("fieldDistribution")}</h2>
          <span>{f.number(fields.length)}</span>
        </div>
        {fields.length ? (
          <div className={styles.scroll}>
            <table className={styles.narrow}>
              <thead>
                <tr>
                  <th scope="col">{t("field")}</th>
                  <th scope="col">{t("documents")}</th>
                  <th scope="col">%</th>
                </tr>
              </thead>
              <tbody>
                {fields.map(({ field, count }) => (
                  <tr key={field}>
                    <th scope="row">
                      <code className={styles.name}>{field}</code>
                    </th>
                    <td className={styles.strong}>{f.number(count)}</td>
                    <td>
                      <span className={styles.meter} aria-hidden="true">
                        <span
                          style={
                            {
                              "--share": `${total ? Math.min(100, (count / total) * 100) : 0}%`,
                            } as CSSProperties
                          }
                        />
                      </span>
                      {total ? Math.round((count / total) * 100) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.meta}>{t("noDocuments")}</p>
        )}
      </section>
    </>
  );
}
