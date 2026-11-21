import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { usePageTitle, usePreferences } from "../../app/Preferences";
import { Dialog } from "../../components/Dialog";
import base from "../meilisearch/Meilisearch.module.css";
import { ciApi, isoOf, type CiPipeline } from "./ci";
import PipelinePage from "./PipelinePage";
import RepoPage from "./RepoPage";
import {
  CiError,
  CiHeading,
  CiStatusBadge,
  RefreshButton,
  useFormat,
} from "./shared";
import styles from "./Ci.module.css";

export default function Ci() {
  usePageTitle("ci");
  return (
    <Routes>
      <Route index element={<Repos />} />
      <Route path="repos/:id" element={<RepoPage />} />
      <Route path="repos/:id/pipelines/:number" element={<PipelinePage />} />
      <Route path="*" element={<Navigate replace to="/ci" />} />
    </Routes>
  );
}

function Repos() {
  const { t } = usePreferences();
  const f = useFormat();
  const [adding, setAdding] = useState(false);
  const overview = useQuery({
    queryKey: ["ci", "overview"],
    queryFn: ({ signal }) => ciApi.overview(signal),
    refetchInterval: 15000,
  });
  const data = overview.data;
  return (
    <>
      <CiHeading>
        {data?.url && (
          <a
            className={base.back}
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("ciOpenWoodpecker")} ↗
          </a>
        )}
        <RefreshButton
          busy={overview.isFetching}
          onClick={() => void overview.refetch()}
        />
        {data && (
          <button className="primary" onClick={() => setAdding(true)}>
            {t("ciAddRepo")}
          </button>
        )}
      </CiHeading>
      <CiError error={overview.error} />
      {overview.isPending && <p className={base.meta}>{t("loading")}</p>}
      {data && (
        <div className={base.page}>
          {data.repos.length ? (
            <section className={base.card}>
              <div className={base.heading}>
                <h2>{t("ciRepositories")}</h2>
                <span>
                  {[data.user, data.version && `Woodpecker ${data.version}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <div className={base.scroll}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("ciRepository")}</th>
                      <th scope="col" className={base.optional}>
                        {t("ciDefaultBranch")}
                      </th>
                      <th scope="col">{t("status")}</th>
                      <th scope="col" className={base.optional}>
                        {t("ciBranch")}
                      </th>
                      <th scope="col" className={base.optional}>
                        {t("ciEnvironment")}
                      </th>
                      <th scope="col" className={base.optional}>
                        {t("ciLastPipeline")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.repos.map((repo) => {
                      const last = repo.lastPipeline;
                      return (
                        <tr key={repo.id}>
                          <th scope="row">
                            <Link
                              className={base.name}
                              to={`/ci/repos/${repo.id}`}
                            >
                              {repo.fullName}
                              {repo.private && (
                                <span className={styles.badge}>
                                  {t("ciPrivate")}
                                </span>
                              )}
                            </Link>
                            {last && (
                              <span
                                className={`${base.kind} ${base.phoneOnly}`}
                              >
                                {lastSummary(last)} ·{" "}
                                {f.date(isoOf(last.started || last.created))}
                              </span>
                            )}
                          </th>
                          <td className={`${base.secondary} ${base.optional}`}>
                            {repo.defaultBranch || "—"}
                          </td>
                          <td>
                            {last ? (
                              <CiStatusBadge status={last.status} />
                            ) : (
                              <span className={base.muted}>
                                {t("ciNoPipelineYet")}
                              </span>
                            )}
                          </td>
                          <td className={base.optional}>
                            {last?.branch || "—"}
                          </td>
                          <td className={base.optional}>
                            {last?.environment || "—"}
                          </td>
                          <td className={`${base.secondary} ${base.optional}`}>
                            {last ? (
                              <Link
                                to={`/ci/repos/${repo.id}/pipelines/${last.number}`}
                              >
                                #{last.number} ·{" "}
                                {f.date(isoOf(last.started || last.created))}
                              </Link>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <div className="empty">
              <h2>{t("ciNoRepos")}</h2>
              <p>{t("ciNoReposHelp")}</p>
              <button className="primary" onClick={() => setAdding(true)}>
                {t("ciAddRepo")}
              </button>
            </div>
          )}
          {data.url && <p className={base.help}>{t("ciSecretsNote")}</p>}
        </div>
      )}
      {adding && <AddRepoDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function lastSummary(pipeline: CiPipeline): string {
  return [`#${pipeline.number}`, pipeline.branch, pipeline.environment]
    .filter(Boolean)
    .join(" · ");
}

function AddRepoDialog({ onClose }: { onClose: () => void }) {
  const { t, locale } = usePreferences();
  const cache = useQueryClient();
  const [filter, setFilter] = useState("");
  const available = useQuery({
    queryKey: ["ci", "available"],
    queryFn: ({ signal }) => ciApi.available(signal),
  });
  const add = useMutation({
    mutationFn: (forgeRemoteId: string) => ciApi.addRepo(forgeRemoteId),
    onSuccess: () =>
      Promise.all([
        cache.invalidateQueries({ queryKey: ["ci", "overview"] }),
        cache.invalidateQueries({ queryKey: ["ci", "available"] }),
      ]),
  });
  const needle = filter.trim().toLocaleLowerCase(locale);
  const repos = (available.data?.repos || []).filter((repo) =>
    repo.fullName.toLocaleLowerCase(locale).includes(needle),
  );
  return (
    <Dialog title={t("ciAddRepo")} onClose={onClose}>
      <input
        type="search"
        autoFocus
        aria-label={t("ciFilterRepos")}
        placeholder={t("ciFilterRepos")}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <CiError error={available.error || add.error} />
      {available.isPending && <p>{t("loading")}</p>}
      {available.data &&
        (repos.length ? (
          <ul className={styles.available}>
            {repos.map((repo) => (
              <li key={repo.forgeRemoteId}>
                <span className={styles.availableName}>
                  {repo.fullName}
                  {repo.private && (
                    <span className={styles.badge}>{t("ciPrivate")}</span>
                  )}
                </span>
                {repo.active ? (
                  <span className={styles.ok}>{t("ciAdded")} ✓</span>
                ) : (
                  <button
                    className="ghost"
                    disabled={add.isPending}
                    onClick={() => add.mutate(repo.forgeRemoteId)}
                  >
                    {add.isPending && add.variables === repo.forgeRemoteId
                      ? t("ciAdding")
                      : t("ciAdd")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>{t("ciNoAvailable")}</p>
        ))}
    </Dialog>
  );
}
