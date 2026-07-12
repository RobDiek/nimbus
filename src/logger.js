export function createLogger(baseContext = {}) {
  const format = (level, message, context = {}) => {
    const payload = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...baseContext,
      ...context,
    };
    return JSON.stringify(payload);
  };

  return {
    info(message, context = {}) {
      console.log(format("info", message, context));
    },
    warn(message, context = {}) {
      console.warn(format("warn", message, context));
    },
    error(message, context = {}) {
      console.error(format("error", message, context));
    },
  };
}

export const logger = createLogger({ service: "nimbus" });
