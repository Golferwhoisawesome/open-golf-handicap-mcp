import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export class Confirmations {
  constructor(
    private readonly key: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    if (key.length < 32)
      throw new Error("Confirmation key must be at least 32 bytes");
  }
  issue(
    subject: string,
    action: string,
    payload: unknown,
    state: unknown,
  ): string {
    const body = Buffer.from(
      JSON.stringify({
        owner: digest(subject),
        action,
        payload: digest(payload),
        state: digest(state),
        expires: this.now() + 300_000,
      }),
    ).toString("base64url");
    return (
      body +
      "." +
      createHmac("sha256", this.key).update(body).digest("base64url")
    );
  }
  verify(
    token: string,
    subject: string,
    action: string,
    payload: unknown,
    state: unknown,
  ): void {
    try {
      const [body, signature, ...extra] = token.split(".");
      if (!body || !signature || extra.length || token.length > 2048)
        throw new Error();
      const expected = createHmac("sha256", this.key).update(body).digest();
      const supplied = Buffer.from(signature, "base64url");
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new Error();
      const parsed = JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      );
      if (
        parsed.owner !== digest(subject) ||
        parsed.action !== action ||
        parsed.payload !== digest(payload) ||
        parsed.state !== digest(state) ||
        !Number.isFinite(parsed.expires) ||
        parsed.expires <= this.now()
      )
        throw new Error();
    } catch {
      throw new AppError(
        "CONFIRMATION_REQUIRED",
        "Preview expired or does not match",
      );
    }
  }
}
