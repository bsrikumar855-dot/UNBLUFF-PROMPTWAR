import { pino, type DestinationStream, type Logger } from "pino";

/** Maps pino levels to Cloud Logging `severity` so Cloud Run shows the right level. */
const SEVERITY: Record<string, string> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

/** `destination` defaults to stdout; tests pass a stream to inspect what would be written. */
export function createLogger(
  level = process.env.LOG_LEVEL ?? "info",
  destination?: DestinationStream,
): Logger {
  const options: pino.LoggerOptions = {
    level,
    messageKey: "message",
    base: undefined,
    formatters: {
      level: (label) => ({ severity: SEVERITY[label] ?? "DEFAULT", level: label }),
    },
    // Defense in depth: never let a key reach the logs even if someone logs a config object.
    redact: {
      paths: [
        "apiKey",
        "*.apiKey",
        "GEMINI_API_KEY",
        "*.GEMINI_API_KEY",
        "GEMINI_FALLBACK_API_KEY",
        "*.GEMINI_FALLBACK_API_KEY",
        "fallbackApiKey",
        "*.fallbackApiKey",
        "req.headers.authorization",
        "access_token",
        "*.access_token",
        "token",
        "*.token",
        "code",
        "*.code",
        "state",
        "*.state",
        "code_verifier",
        "*.code_verifier",
        "client_secret",
        "*.client_secret",
        "GITHUB_CLIENT_SECRET",
        "*.GITHUB_CLIENT_SECRET",
        "GITHUB_TOKEN_ENCRYPTION_KEY",
        "*.GITHUB_TOKEN_ENCRYPTION_KEY",
      ],
      censor: "[redacted]",
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
