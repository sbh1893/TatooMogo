/**
 * Development-only D1 meter for the load script (scripts/load-test.ts): counts queries and the
 * rows_read / rows_written D1 reports. raw()/first() carry no meta, so they are served from all()
 * here — the same object→array mapping drizzle itself uses for batch results. Duplicate column
 * names would collapse, which is why this is opt-in per request and never on in production.
 */
export type Meter = { q: number; read: number; write: number };

export function meterD1(db: D1Database, m: Meter): D1Database {
  const add = (r: D1Result) => {
    m.q++;
    m.read += r.meta?.rows_read ?? 0;
    m.write += r.meta?.rows_written ?? 0;
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = {
      bind: (...v: unknown[]) => wrap(s.bind(...v)),
      all: async () => {
        const r = await s.all();
        add(r);
        return r;
      },
      run: async () => {
        const r = await s.run();
        add(r);
        return r;
      },
      raw: async () => (await p.all()).results.map((row) => Object.values(row as object)),
      first: async (col?: string) => {
        const row = (await p.all()).results[0] as Record<string, unknown> | undefined;
        return row === undefined ? null : col ? row[col] : row;
      },
    } as unknown as D1PreparedStatement;
    real.set(p, s);
    return p;
  };
  return new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (q: string) => wrap(t.prepare(q));
      if (k === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          const rs = await t.batch(stmts.map((s) => real.get(s) ?? s));
          rs.forEach(add);
          return rs;
        };
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
