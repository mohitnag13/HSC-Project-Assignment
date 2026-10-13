export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  bindings?: LogFields;
  write?: (line: string) => void;
}

/**
 * Minimal structured logger. JSON lines by default so container logs can be
 * shipped to the client's SIEM as-is. Callers must never pass PHI or secrets:
 * the pipeline logs patient IDs and counts only.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const format = options.format ?? 'json';
  const bindings = options.bindings ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const log = (entryLevel: LogLevel, message: string, fields: LogFields = {}) => {
    if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) return;
    const time = new Date().toISOString();
    const context = { ...bindings, ...fields };
    if (format === 'json') {
      write(JSON.stringify({ time, level: entryLevel, msg: message, ...context }));
      return;
    }
    const details = Object.entries(context)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    write(`${time.slice(11, 23)} ${entryLevel.toUpperCase().padEnd(5)} ${message}${details ? `  ${details}` : ''}`);
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    child: (childBindings) => createLogger({ ...options, bindings: { ...bindings, ...childBindings } }),
  };
}

export const silentLogger: Logger = createLogger({ write: () => undefined });
