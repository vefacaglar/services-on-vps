import CodeMirror from "@uiw/react-codemirror";
import {
  Decoration,
  EditorView,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  keywordCompletionSource,
  PostgreSQL,
  schemaCompletionSource,
  sql,
} from "@codemirror/lang-sql";
import {
  HighlightStyle,
  syntaxHighlighting,
  StreamLanguage,
} from "@codemirror/language";
import {
  autocompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePreferences } from "../app/Preferences";
import {
  columnCompletions,
  completionNamespace,
  sqlFunctions,
  type DbSchema,
} from "../lib/sqlCompletion";

/** The text to run: the selection when there is one, else everything. */
export type RunTarget = { text: string; from: number } | undefined;

// Error underline: a PostgreSQL error position mapped to a document range.
const setError = StateEffect.define<{ from: number; to: number } | null>();
const errorMark = Decoration.mark({ class: "cm-pgError" });
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects)
      if (effect.is(setError))
        return effect.value && effect.value.to > effect.value.from
          ? Decoration.set([
              errorMark.range(
                Math.min(effect.value.from, tr.state.doc.length),
                Math.min(effect.value.to, tr.state.doc.length),
              ),
            ])
          : Decoration.none;
    return tr.docChanged ? Decoration.none : marks.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function sqlExtensions(schema: DbSchema | undefined): Extension[] {
  const namespace = completionNamespace(schema);
  const config = {
    dialect: PostgreSQL,
    schema: namespace,
    defaultSchema: "public",
    upperCaseKeywords: true,
  };
  const columns = (context: CompletionContext) => {
    const word = context.matchBefore(/[\w$]*/);
    if (!word || (!word.text && !context.explicit)) return null;
    // After "x." the schema source completes the members of x.
    if (context.state.sliceDoc(word.from - 1, word.from) === ".") return null;
    return {
      from: word.from,
      options: [
        ...columnCompletions(context.state.doc.toString(), schema),
        ...sqlFunctions,
      ],
      validFor: /^[\w$]*$/,
    };
  };
  return [
    sql(config),
    autocompletion({
      override: [
        schemaCompletionSource(config),
        columns,
        keywordCompletionSource(PostgreSQL, true),
      ],
    }),
  ];
}
const logsql = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (
      stream.match(
        /^(?:stats|by|count|sum|avg|min|max|sort|desc|asc|limit|offset|fields|filter|uniq|top|AND|OR|NOT|in|math|format|extract|replace|as|unroll|join)\b/i,
      )
    )
      return "keyword";
    if (stream.match(/^\d+(?:\.\d+)?(?:ns|ms|s|m|h|d|w)?\b/)) return "number";
    if (stream.match(/^[\w.]+(?=\s*:)/)) return "propertyName";
    if (stream.match(/^[|:=!<>()[\],]+/)) return "operator";
    stream.next();
    return null;
  },
});
export function QueryEditor({
  value,
  onChange,
  onRun,
  fields,
  wrap,
  mode = "logsql",
  schema,
  error,
  onSelection,
  height,
  onView,
}: {
  value: string;
  onChange: (v: string) => void;
  onRun: (target?: RunTarget) => void;
  fields: string[];
  wrap: boolean;
  mode?: "logsql" | "sql";
  /** SQL mode: tables and columns for completion. */
  schema?: DbSchema;
  /** SQL mode: document range to underline as the error. */
  error?: { from: number; to: number } | null;
  /** SQL mode: the current selection (undefined when empty). */
  onSelection?: (target: RunTarget) => void;
  height?: string;
  /** SQL mode: receives the editor view (e.g. to insert text at the cursor). */
  onView?: (view: EditorView) => void;
}) {
  const { theme, language, t } = usePreferences();
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const selectionRef = useRef(onSelection);
  selectionRef.current = onSelection;
  const [view, setView] = useState<EditorView | null>(null);
  useEffect(() => {
    if (view && mode === "sql") view.dispatch({ effects: setError.of(error || null) });
  }, [view, error, mode]);
  const extensions = useMemo(() => {
    const complete = (context: CompletionContext) => {
      const word = context.matchBefore(/[\w._]*/);
      if (!word || (!word.text && !context.explicit)) return null;
      return {
        from: word.from,
        options: [
          ...fields.map((label) => ({ label, type: "property" })),
          ...[
            "stats",
            "count()",
            "sum()",
            "avg()",
            "sort",
            "by",
            "limit",
            "fields",
            "uniq",
            "top",
            "filter",
            "AND",
            "OR",
            "NOT",
          ].map((label) => ({ label, type: "keyword" })),
        ],
      };
    };
    const nonce =
      document.querySelector<HTMLMetaElement>("meta[name=csp-nonce]")
        ?.content || "";
    const target = (view: EditorView): RunTarget => {
      const range = view.state.selection.main;
      return range.empty
        ? undefined
        : { text: view.state.sliceDoc(range.from, range.to), from: range.from };
    };
    return [
      ...(mode === "sql"
        ? [
            ...sqlExtensions(schema),
            errorField,
            EditorView.updateListener.of((update) => {
              if (update.selectionSet || update.docChanged)
                selectionRef.current?.(target(update.view));
            }),
          ]
        : [logsql, autocompletion({ override: [complete] })]),
      syntaxHighlighting(
        HighlightStyle.define([
          { tag: tags.keyword, color: "var(--accent)" },
          { tag: tags.string, color: "var(--success)" },
          { tag: tags.number, color: "var(--info)" },
          { tag: tags.propertyName, color: "var(--text)" },
          { tag: tags.operator, color: "var(--muted)" },
          { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
          { tag: tags.typeName, color: "var(--warning)" },
          { tag: [tags.bool, tags.null], color: "var(--info)" },
          { tag: tags.special(tags.string), color: "var(--text)" },
        ]),
      ),
      EditorView.contentAttributes.of({ "aria-label": t("query") }),
      Prec.highest(
        keymap.of(
          (mode === "sql"
            ? ["Ctrl-Enter", "Meta-Enter", "F5"]
            : ["Ctrl-Enter", "Meta-Enter"]
          ).map((key) => ({
            key,
            preventDefault: true,
            run: (view: EditorView) => {
              runRef.current(mode === "sql" ? target(view) : undefined);
              return true;
            },
          })),
        ),
      ),
      EditorView.cspNonce.of(nonce),
      EditorView.theme(
        {
          "&": {
            backgroundColor: "var(--surface)",
            color: "var(--text)",
            fontSize: "13px",
          },
          "&.cm-focused": { outline: "1px solid var(--accent)" },
          ".cm-scroller": { backgroundColor: "var(--surface)" },
          ".cm-content": {
            fontFamily: "var(--font)",
            lineHeight: "1.9",
            padding: "12px 0",
            caretColor: "var(--text)",
          },
          ".cm-gutters": {
            backgroundColor: "var(--bg)",
            color: "var(--muted)",
            borderRight: "1px solid var(--border)",
          },
          ".cm-activeLine,.cm-activeLineGutter": {
            backgroundColor: "var(--surface-2)",
          },
          ".cm-selectionBackground,&.cm-focused .cm-selectionBackground": {
            backgroundColor: "var(--border)",
          },
          ".cm-cursor": { borderLeftColor: "var(--text)" },
          ".cm-tooltip": {
            backgroundColor: "var(--surface)",
            color: "var(--text)",
            border: "1px solid var(--border)",
          },
          ".cm-completionIcon": { display: "none" },
          ".cm-completionDetail": {
            color: "var(--muted)",
            fontStyle: "normal",
            marginLeft: "1em",
          },
          ".cm-tooltip-autocomplete ul li[aria-selected]": {
            backgroundColor: "var(--surface-2)",
            color: "var(--heading)",
          },
          ".cm-pgError": {
            textDecoration: "underline wavy var(--error)",
            textUnderlineOffset: "3px",
          },
          ".cm-searchMatch": { backgroundColor: "var(--border)" },
          ".cm-panels": {
            backgroundColor: "var(--surface)",
            color: "var(--text)",
          },
        },
        { dark: theme === "dark" },
      ),
      EditorState.phrases.of(
        language === "tr"
          ? {
              Find: "Bul",
              Replace: "Değiştir",
              "Replace all": "Tümünü değiştir",
              next: "sonraki",
              previous: "önceki",
              all: "tümü",
              "match case": "büyük/küçük harf",
              "by word": "tam sözcük",
              regexp: "düzenli ifade",
              close: "kapat",
              "No diagnostics": "Tanı yok",
            }
          : {},
      ),
      ...(wrap ? [EditorView.lineWrapping] : []),
    ];
  }, [theme, language, fields, wrap, mode, schema]);
  return (
    <CodeMirror
      theme="none"
      value={value}
      onChange={onChange}
      minHeight={height ? undefined : "108px"}
      maxHeight={height ? undefined : "360px"}
      height={height}
      extensions={extensions}
      onCreateEditor={(created) => {
        setView(created);
        onView?.(created);
      }}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
        autocompletion: false,
        searchKeymap: true,
      }}
      aria-label={t("query")}
    />
  );
}
