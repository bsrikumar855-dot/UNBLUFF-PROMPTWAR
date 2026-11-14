import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";

function capture() {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => void lines.push(s) } };
}

describe("logger redaction", () => {
  it("never writes API keys, tokens, client secrets or the Authorization header", () => {
    const { lines, stream } = capture();
    const log = createLogger("info", stream);
    const secret = "placeholder-secret-value-for-redaction-test";
    log.info({ GEMINI_API_KEY: secret, config: { apiKey: secret, client_secret: secret, token: secret }, req: { headers: { authorization: `Bearer ${secret}` } } }, "config loaded");
    const out = lines.join("");
    expect(out).toContain("config loaded");
    expect(out).not.toContain(secret);
    expect(out.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("maps levels to Cloud Logging severity", () => {
    const { lines, stream } = capture();
    createLogger("info", stream).warn("careful");
    expect(JSON.parse(lines[0]!)).toMatchObject({ severity: "WARNING", level: "warn", message: "careful" });
  });
});
