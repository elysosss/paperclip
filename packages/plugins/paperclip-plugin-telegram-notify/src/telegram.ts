/**
 * Minimal Telegram Bot API client — `sendMessage` and nothing else.
 *
 * Deliberately send-only. Phase 1 of the spec is notifications; `getUpdates`,
 * webhooks and inline keyboards belong to later phases and each one widens the
 * threat model, so none of them has a stub here to grow into by accident.
 *
 * The token never appears in a URL this client logs: Telegram puts it in the
 * path (`/bot<TOKEN>/sendMessage`), so any error raised here names the method,
 * never the full URL.
 */

import { TELEGRAM_API_BASE } from "./constants.js";

export interface TelegramClientOptions {
  /** Resolved per call by the caller — never cached or logged here. */
  token: string;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  apiBaseUrl?: string;
  /** How long a single send may take before it is abandoned. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when Telegram asked us to back off rather than refusing outright. */
    readonly retryable: boolean,
    /** Seconds Telegram asked us to wait, when it said so (429). */
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

/**
 * Escapes the five characters that turn a message into malformed HTML.
 * Task titles and error text are arbitrary strings — an unescaped `<` makes
 * Telegram reject the whole message with a 400 that reads like a bug in us.
 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export class TelegramClient {
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: TelegramClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? TELEGRAM_API_BASE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendMessage(input: { chatId: string; text: string }): Promise<void> {
    // A hung connection to Telegram must not hold a worker handler open for
    // ever. The mirror's missing deadline is exactly this bug (kit #11).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.options.fetchImpl(
        `${this.apiBaseUrl}/bot${this.options.token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            chat_id: input.chatId,
            text: input.text,
            parse_mode: "HTML",
            // A board link would otherwise render a preview card of a page
            // Telegram cannot reach anyway — it is on a private LAN.
            disable_web_page_preview: true,
          }),
        },
      );
    } catch (error) {
      // An abort or a socket failure is transient by definition.
      throw new TelegramApiError(
        `sendMessage failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return;

    const body = await response.text().catch(() => "");
    const retryAfterSec = parseRetryAfter(body, response.headers?.get?.("retry-after") ?? null);
    // 429 and 5xx are Telegram asking for time. 400/403 are us: a bad chat id,
    // a blocked bot, malformed HTML. Retrying those repeats the same failure.
    const retryable = response.status === 429 || response.status >= 500;
    throw new TelegramApiError(
      `sendMessage failed with ${response.status}: ${truncate(body, 200)}`,
      response.status,
      retryable,
      retryAfterSec,
    );
  }
}

function parseRetryAfter(body: string, header: string | null): number | null {
  const fromHeader = header !== null ? Number.parseInt(header, 10) : Number.NaN;
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;
  try {
    const parsed = JSON.parse(body) as { parameters?: { retry_after?: unknown } };
    const value = parsed?.parameters?.retry_after;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
