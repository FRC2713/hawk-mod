type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const min = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 1;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < min) return;
  const line = { t: new Date().toISOString(), level, msg, ...fields };
  // Every level goes to stderr, info included. The CLI writes its result to
  // stdout, and a caller piping that into a parser must not also receive log
  // lines — that failure reads as "the command broke" rather than "the log
  // got in the way".
  console.error(JSON.stringify(line));
}

/**
 * Never log message text. Monitored DM content belongs in the database, which
 * is access-controlled and auditable; stdout is neither.
 */
export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
