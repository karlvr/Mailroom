// An Env whose DB is a new SQLite database, the database engine of D1, with every migration applied.
// A small shim gives the parts of the D1 API that src/db.ts uses.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrations = resolve(import.meta.dirname, "../../migrations");

/** Returns a new Env with an empty database, and the SQLite database itself for checks. */
export function sqliteEnv() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrations).sort()) sqlite.exec(readFileSync(join(migrations, f), "utf8"));
  // Like D1, a result has the rows that the statement returns, and the number of rows that it changed.
  const execute = (sql, params) => {
    // D1 accepts at most 100 bound parameters in one statement. SQLite accepts many more.
    if (params.length > 100) throw new Error(`D1_ERROR: too many SQL variables: ${params.length}`);
    const s = sqlite.prepare(sql);
    if (s.columns().length === 0) {
      const r = s.run(...params);
      return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    const results = s.all(...params);
    return { results, meta: { changes: Number(sqlite.prepare("SELECT changes() AS n").get().n) } };
  };
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => statement(sql, p),
    first: async () => execute(sql, params).results[0] ?? null,
    all: async () => execute(sql, params),
    run: async () => execute(sql, params),
  });
  const DB = {
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      sqlite.exec("BEGIN");
      try {
        const out = list.map((s) => execute(s.sql, s.params));
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { env: { DB }, sqlite };
}

/** Inserts a row with the given values, and a placeholder in each other column that must have a value. */
export function insertRow(sqlite, table, values) {
  const row = { ...values };
  for (const c of sqlite.prepare(`PRAGMA table_info(${table})`).all()) {
    if (c.name in row || !c.notnull || c.dflt_value !== null) continue;
    row[c.name] = /INT/i.test(c.type) ? 0 : "x";
  }
  const names = Object.keys(row);
  sqlite.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
}
