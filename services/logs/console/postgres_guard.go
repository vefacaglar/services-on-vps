package main

import "strings"

// A small SQL lexer for user statements. It is a best-effort guard, not a
// parser: it strips comments, follows string, quoted-identifier and
// dollar-quoted bodies and parenthesis depth, and reports
//   - the first keyword and the main verb (after a WITH clause),
//   - whether a top-level WHERE exists (UPDATE/DELETE without WHERE),
//   - blocked constructs: COPY and server-file/program functions.
// Text inside literals and function bodies is scanned for blocked names too,
// so a DO block or EXECUTE string cannot hide them trivially. Dynamic SQL
// built by concatenation still can; the real protection is a non-superuser
// role (docs/postgres-inspector.md).

type sqlWord struct {
	text   string // lowercased
	depth  int    // parenthesis depth; -1 inside literals and bodies
	quoted bool   // "quoted identifier"
}

type sqlInfo struct {
	first, second string
	verb          string // main verb: first, or the statement after WITH
	topWhere      bool
	selectInto    bool
	blocked       string // human-readable name of the blocked construct
}

// blockedFunctions read or write server files, run programs or reach other
// servers. Matched case-insensitively against every word, including words
// inside literals and function bodies.
var blockedFunctions = map[string]bool{
	"pg_read_file": true, "pg_read_binary_file": true, "pg_stat_file": true,
	"pg_ls_dir": true, "pg_ls_logdir": true, "pg_ls_waldir": true, "pg_ls_tmpdir": true,
	"pg_ls_archive_statusdir": true, "pg_ls_logicalsnapdir": true, "pg_ls_logicalmapdir": true,
	"pg_ls_replslotdir": true, "pg_ls_summariesdir": true,
	"lo_import": true, "lo_export": true,
	"pg_file_write": true, "pg_file_rename": true, "pg_file_unlink": true, "pg_file_sync": true,
	"pg_logdir_ls": true, "file_fdw": true, "adminpack": true,
	"plpythonu": true, "plpython2u": true, "plpython3u": true, "plperlu": true, "pltclu": true,
}

func blockedWord(word string) bool {
	return blockedFunctions[word] || strings.HasPrefix(word, "dblink") || strings.HasPrefix(word, "postgres_fdw")
}

func identStart(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= 0x80
}

func identPart(c byte) bool {
	return identStart(c) || c >= '0' && c <= '9' || c == '$'
}

// lexSQL appends the words of sql. inner marks text from a literal or body.
func lexSQL(sql string, inner bool, words *[]sqlWord) {
	depth := 0
	at := func() int {
		if inner {
			return -1
		}
		return depth
	}
	for i := 0; i < len(sql); {
		c := sql[i]
		switch {
		case c == '-' && i+1 < len(sql) && sql[i+1] == '-':
			for i < len(sql) && sql[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(sql) && sql[i+1] == '*':
			nest := 0
			for i < len(sql) {
				if sql[i] == '/' && i+1 < len(sql) && sql[i+1] == '*' {
					nest++
					i += 2
				} else if sql[i] == '*' && i+1 < len(sql) && sql[i+1] == '/' {
					nest--
					i += 2
					if nest == 0 {
						break
					}
				} else {
					i++
				}
			}
		case c == '\'':
			escape := i > 0 && (sql[i-1] == 'e' || sql[i-1] == 'E') && (i < 2 || !identPart(sql[i-2]))
			start := i + 1
			i++
			for i < len(sql) {
				if escape && sql[i] == '\\' {
					i += 2
					continue
				}
				if sql[i] == '\'' {
					if i+1 < len(sql) && sql[i+1] == '\'' {
						i += 2
						continue
					}
					break
				}
				i++
			}
			lexSQL(strings.ReplaceAll(sql[start:min(i, len(sql))], "''", "'"), true, words)
			i++
		case c == '"':
			start := i + 1
			i++
			for i < len(sql) {
				if sql[i] == '"' {
					if i+1 < len(sql) && sql[i+1] == '"' {
						i += 2
						continue
					}
					break
				}
				i++
			}
			name := strings.ReplaceAll(sql[start:min(i, len(sql))], `""`, `"`)
			*words = append(*words, sqlWord{text: strings.ToLower(name), depth: at(), quoted: true})
			i++
		case c == '$' && (i == 0 || !identPart(sql[i-1])):
			// $tag$ ... $tag$; $1 parameters fall through as punctuation.
			j := i + 1
			for j < len(sql) && identPart(sql[j]) && sql[j] != '$' {
				j++
			}
			if j < len(sql) && sql[j] == '$' && (j == i+1 || identStart(sql[i+1])) {
				tag := sql[i : j+1]
				end := strings.Index(sql[j+1:], tag)
				if end < 0 {
					lexSQL(sql[j+1:], true, words)
					return
				}
				lexSQL(sql[j+1:j+1+end], true, words)
				i = j + 1 + end + len(tag)
			} else {
				i++
			}
		case identStart(c):
			start := i
			for i < len(sql) && identPart(sql[i]) {
				i++
			}
			*words = append(*words, sqlWord{text: strings.ToLower(sql[start:i]), depth: at()})
		case c == '(':
			depth++
			i++
		case c == ')':
			depth--
			i++
		default:
			i++
		}
	}
}

var statementVerbs = map[string]bool{"select": true, "insert": true, "update": true, "delete": true, "merge": true, "values": true, "table": true}

func analyzeSQL(sql string) sqlInfo {
	var words []sqlWord
	lexSQL(sql, false, &words)
	var info sqlInfo
	var top []string
	copyInner := false
	for _, w := range words {
		if blockedWord(w.text) && info.blocked == "" {
			info.blocked = w.text
		}
		if w.depth == -1 {
			// COPY hidden in a DO block or EXECUTE string.
			if w.text == "copy" {
				copyInner = true
			} else if copyInner && (w.text == "to" || w.text == "from" || w.text == "program") && info.blocked == "" {
				info.blocked = "COPY"
			}
			continue
		}
		if w.depth == 0 && !w.quoted {
			top = append(top, w.text)
		}
	}
	if len(top) > 0 {
		info.first = top[0]
	}
	if len(top) > 1 {
		info.second = top[1]
	}
	if info.first == "copy" {
		info.blocked = "COPY"
	}
	info.verb = info.first
	if info.first == "with" {
		info.verb = ""
		for _, w := range top[1:] {
			if statementVerbs[w] {
				info.verb = w
				break
			}
		}
	}
	afterVerb := false
	for _, w := range top {
		if w == info.verb {
			afterVerb = true
		}
		if afterVerb && w == "where" {
			info.topWhere = true
		}
		if afterVerb && info.verb == "select" && w == "into" {
			info.selectInto = true
		}
	}
	return info
}

// transactionControl reports statements that would end or split the
// console's own transaction.
func (info sqlInfo) transactionControl() bool {
	switch info.first {
	case "begin", "start", "commit", "end", "rollback", "abort", "savepoint", "release":
		return true
	case "prepare":
		return info.second == "transaction"
	}
	return false
}

func blockedError(name string) *pgError {
	return &pgError{status: 400, code: "blocked_statement",
		message: "Bu konsolda " + name + " kullanılamaz: sunucu dosyalarına, programlara veya başka sunuculara erişen ifadeler engellenir."}
}
