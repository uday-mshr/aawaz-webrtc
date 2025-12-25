/* Simple logger wrapper to centralize logging across the app */

type LogFields = Record<string, unknown> | undefined;

const format = (level: string, message: string, fields?: LogFields) => {
  const base = { level, message, timestamp: new Date().toISOString() } as Record<string, unknown>;
  if (fields && Object.keys(fields).length > 0) {
    Object.assign(base, fields);
  }
  return JSON.stringify(base);
};

export const logger = {
  info(message: string, fields?: LogFields) {
    console.log(format('info', message, fields));
  },
  warn(message: string, fields?: LogFields) {
    console.warn(format('warn', message, fields));
  },
  error(message: string, fields?: LogFields) {
    console.error(format('error', message, fields));
  },
  debug(message: string, fields?: LogFields) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(format('debug', message, fields));
    }
  },
};

export default logger;
