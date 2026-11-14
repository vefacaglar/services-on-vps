import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import type { DbSchema } from "../../lib/sqlCompletion";
import { sqlIdent, sqlName, tablePath, type TableDetail } from "./pg";
import { usePg } from "./shared";
import styles from "./Workspace.module.css";

function Node({
  label,
  meta,
  open,
  onToggle,
  children,
  actions,
  level,
}: {
  label: ReactNode;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
  actions?: ReactNode;
  level: number;
}) {
  return (
    <li role="treeitem" aria-expanded={open} aria-level={level}>
      <div className={styles.node}>
        <button className={styles.twisty} onClick={onToggle}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span className={styles.nodeLabel}>{label}</span>
          {meta !== undefined && <span className={styles.nodeMeta}>{meta}</span>}
        </button>
        {actions}
      </div>
      {open && <ul role="group">{children}</ul>}
    </li>
  );
}

function Indexes({ db, schema, table }: { db: string; schema: string; table: string }) {
  const { t } = usePreferences();
  const detail = usePg<TableDetail>(tablePath(db, schema, table));
  if (detail.isPending) return <li className={styles.leaf}>{t("loading")}</li>;
  if (detail.error || !detail.data) return <li className={styles.leaf}>—</li>;
  if (!detail.data.indexes.length)
    return <li className={styles.leaf}>{t("pgNoIndexes")}</li>;
  return (
    <>
      {detail.data.indexes.map((i) => (
        <li key={i.name} className={styles.leaf} title={i.definition}>
          <span className={styles.icon} aria-hidden="true">
            {i.primary ? "⚿" : i.unique ? "◆" : "◇"}
          </span>
          {i.name}
        </li>
      ))}
    </>
  );
}

/** Object explorer: Database → Schemas → Tables/Views → Columns/Indexes. */
export function Explorer({
  db,
  schema,
  loading,
  onInsert,
  onSelectTop,
}: {
  db: string;
  schema: DbSchema | undefined;
  loading: boolean;
  onInsert: (text: string) => void;
  onSelectTop: (schema: string, table: string) => void;
}) {
  const { t } = usePreferences();
  const [open, setOpen] = useState<Set<string>>(() => new Set(["db", "s:public", "f:public:table"]));
  const [filter, setFilter] = useState("");
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const needle = filter.trim().toLowerCase();
  const schemas = Object.entries(schema?.schemas || {});
  return (
    <nav className={styles.explorer} aria-label={t("pgExplorer")}>
      <input
        className={styles.explorerFilter}
        type="search"
        placeholder={t("pgFilterTables")}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ul role="tree" className={styles.tree}>
        <Node
          level={1}
          label={<strong>{db}</strong>}
          open={open.has("db")}
          onToggle={() => toggle("db")}
        >
          {loading && <li className={styles.leaf}>{t("loading")}</li>}
          {schema?.truncated && <li className={styles.leaf}>{t("pgSchemaTruncated")}</li>}
          {schemas.map(([name, tables]) => {
            const entries = Object.entries(tables).filter(([table]) =>
              needle ? `${name}.${table}`.toLowerCase().includes(needle) : true,
            );
            if (needle && !entries.length) return null;
            const kinds = schema?.kinds?.[name] || {};
            const groups = [
              { kind: "table", label: t("pgTables"), items: entries.filter(([x]) => (kinds[x] || "table") === "table") },
              { kind: "view", label: t("pgViews"), items: entries.filter(([x]) => (kinds[x] || "table") !== "table") },
            ];
            const schemaOpen = open.has(`s:${name}`) || !!needle;
            return (
              <Node
                key={name}
                level={2}
                label={name}
                meta={entries.length}
                open={schemaOpen}
                onToggle={() => toggle(`s:${name}`)}
              >
                {groups.map((group) =>
                  group.items.length ? (
                    <Node
                      key={group.kind}
                      level={3}
                      label={group.label}
                      meta={group.items.length}
                      open={open.has(`f:${name}:${group.kind}`) || !!needle}
                      onToggle={() => toggle(`f:${name}:${group.kind}`)}
                    >
                      {group.items.map(([table, columns]) => {
                        const key = `t:${name}:${table}`;
                        return (
                          <Node
                            key={table}
                            level={4}
                            label={table}
                            open={open.has(key)}
                            onToggle={() => toggle(key)}
                            actions={
                              <span className={styles.nodeActions}>
                                <button
                                  className="text-button"
                                  title={t("pgInsertName")}
                                  aria-label={`${t("pgInsertName")}: ${table}`}
                                  onClick={() => onInsert(sqlName(name, table))}
                                >
                                  ⤶
                                </button>
                                <button
                                  className="text-button"
                                  title={t("pgSelectTop")}
                                  aria-label={`${t("pgSelectTop")}: ${table}`}
                                  onClick={() => onSelectTop(name, table)}
                                >
                                  ▶
                                </button>
                                <Link
                                  to={tablePath(db, name, table)}
                                  title={t("pgOpenTable")}
                                  aria-label={`${t("pgOpenTable")}: ${table}`}
                                >
                                  ↗
                                </Link>
                              </span>
                            }
                          >
                            <Node
                              level={5}
                              label={t("tabColumns")}
                              meta={columns.length}
                              open={open.has(`${key}:c`)}
                              onToggle={() => toggle(`${key}:c`)}
                            >
                              {columns.map((c) => (
                                <li key={c.name} className={styles.leaf}>
                                  <button
                                    className={styles.leafButton}
                                    title={t("pgInsertName")}
                                    onClick={() => onInsert(sqlIdent(c.name))}
                                  >
                                    <span
                                      className={styles.icon}
                                      title={c.pk ? t("pgPrimary") : undefined}
                                      aria-label={c.pk ? t("pgPrimary") : undefined}
                                    >
                                      {c.pk ? "⚿" : ""}
                                    </span>
                                    {c.name}
                                    <span className={styles.nodeMeta}>
                                      {c.type}
                                      {c.nullable ? "" : " · NOT NULL"}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </Node>
                            {(kinds[table] || "table") === "table" && (
                              <Node
                                level={5}
                                label={t("tabIndexes")}
                                open={open.has(`${key}:i`)}
                                onToggle={() => toggle(`${key}:i`)}
                              >
                                <Indexes db={db} schema={name} table={table} />
                              </Node>
                            )}
                          </Node>
                        );
                      })}
                    </Node>
                  ) : null,
                )}
              </Node>
            );
          })}
        </Node>
      </ul>
    </nav>
  );
}
