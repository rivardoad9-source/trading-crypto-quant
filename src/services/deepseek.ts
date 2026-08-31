import OpenAI from "openai";
import { z, type ZodType } from "zod";
import { env, hasDeepSeek } from "../config/env.js";

/**
 * DeepSeek is OpenAI-API-compatible, so the official `openai` SDK is used with a
 * rewritten baseURL. Do NOT swap this for an OpenAI/Anthropic model — the PRD pins
 * the provider to DeepSeek (deepseek-chat / deepseek-reasoner).
 */
/*
 * Explicit timeout and retry budget. The SDK defaults to a 10-MINUTE timeout with 2
 * retries, so a hung DeepSeek endpoint could hold a trading cycle for ~30 minutes. The
 * cron lock means that does not stack up ticks, but it does silently stop the screener
 * for half an hour with nothing in the logs to explain it. deepseek-reasoner is slow by
 * design, hence a budget in minutes rather than seconds — but a bounded one.
 */
const client = hasDeepSeek
  ? new OpenAI({
      apiKey: env.DEEPSEEK_API_KEY as string,
      baseURL: env.DEEPSEEK_BASE_URL,
      timeout: env.DEEPSEEK_TIMEOUT_MS,
      maxRetries: 1,
    })
  : null;

export class DeepSeekUnavailableError extends Error {
  constructor() {
    super("DEEPSEEK_API_KEY is not set — DeepSeek calls are disabled.");
    this.name = "DeepSeekUnavailableError";
  }
}

/**
 * The model spent its whole token budget on chain-of-thought and returned no answer.
 *
 * Distinct from a schema-validation failure on purpose: there is nothing to repair and
 * nothing to feed back, so the only sane response is for the caller to skip this cycle.
 * Callers that can do without a decision should catch THIS and skip; a generic catch
 * would also swallow real bugs.
 */
export class DeepSeekTruncatedError extends Error {
  constructor(detail: string) {
    super(`[deepseek] chain-of-thought truncated before an answer was written: ${detail}`);
    this.name = "DeepSeekTruncatedError";
  }
}

/**
 * Hard ceiling on a single deepseek-reasoner call, covering chain-of-thought AND the
 * answer.
 *
 * Locked rather than escalating. The budget used to DOUBLE on a truncated attempt
 * (16000 -> 32000), so one screener tick could pay 48000 reasoning tokens and still
 * return nothing — the failure mode billed twice over. A fixed ceiling makes the
 * worst-case cost of a tick knowable in advance; a run that cannot answer inside it is
 * skipped (see DeepSeekTruncatedError) rather than bought a bigger budget. Callers may
 * ask for LESS, never more.
 *
 * 16000 is measured, not chosen for roundness, and must not be cut without new
 * measurement. Live observation on 2026-08-30 (commit 6a6c23b) found the entry
 * decision's chain-of-thought consistently exceeds 8000 tokens: at 4000/8000 every
 * cycle burned a wasted first attempt and long CoT still hit the cap, returning an
 * empty completion. Lowering this to 8000 would therefore truncate EVERY entry
 * decision, and since truncation now means a skipped cycle rather than a retry at
 * double the budget, the engine would simply stop opening positions. The token bill is
 * cut by the screener's cadence (CRON.DLMM_LOOP, 30m) and by removing the escalation,
 * not by starving the call that has to succeed.
 */
export const REASONER_MAX_TOKENS = 16000;

/**
 * At most one retry — two attempts total.
 *
 * The retry earns its keep on a malformed-JSON answer, where the error is fed back and
 * the model repairs it. It earns nothing on a third pass: by then the prompt is the
 * suspect, and each further attempt is another full chain-of-thought billed for the
 * same tick.
 */
export const MAX_STRUCTURED_ATTEMPTS = 2;

/** Reasoning calls are capped at REASONER_MAX_TOKENS; chat calls keep their own default. */
export function resolveTokenBudget(
  reasoning: boolean | undefined,
  requested: number | undefined,
): number {
  if (!reasoning) return requested ?? 1500;
  return Math.min(requested ?? REASONER_MAX_TOKENS, REASONER_MAX_TOKENS);
}

export interface ChatOptions {
  system: string;
  user: string;
  /** Use the reasoner for multi-step trade decisions, chat for summarisation. */
  reasoning?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export function isDeepSeekAvailable(): boolean {
  return client !== null;
}

/** Plain text completion. Throws DeepSeekUnavailableError when no API key is configured. */
export async function chatCompletion(opts: ChatOptions): Promise<string> {
  if (!client) throw new DeepSeekUnavailableError();

  const model = opts.reasoning ? env.DEEPSEEK_MODEL_REASONER : env.DEEPSEEK_MODEL_CHAT;

  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    // deepseek-reasoner rejects a temperature override; only send it for chat.
    ...(opts.reasoning ? {} : { temperature: opts.temperature ?? 0.4 }),
    max_tokens: resolveTokenBudget(opts.reasoning, opts.maxTokens),
  });

  const content = res.choices[0]?.message?.content;
  if (!content || content.trim() === "") {
    throw new Error("[deepseek] empty completion returned");
  }
  return content.trim();
}

/**
 * Extracts the first JSON object from a model response, tolerating ```json fences
 * and stray prose that the model sometimes wraps around the payload.
 */
export function extractJsonBlock(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`[deepseek] no JSON object found in response: ${raw.slice(0, 200)}`);
  }
  return candidate.slice(start, end + 1);
}

export interface StructuredOptions<T> extends ChatOptions {
  schema: ZodType<T>;
  /**
   * Retries on parse/validation failure, feeding the error back to the model.
   * Clamped to MAX_STRUCTURED_ATTEMPTS — a caller cannot buy more chain-of-thought.
   */
  maxAttempts?: number;
}

/**
 * Requests JSON output and validates it against a Zod schema. On a validation
 * failure the error is fed back to the model so it can repair its own output.
 *
 * Two failure shapes, deliberately reported as different errors:
 *  - malformed or schema-invalid JSON — retried once with the error fed back, then a
 *    plain Error;
 *  - an empty completion (`finish_reason: "length"`), i.e. the reasoner burned the
 *    whole budget thinking — retried once, then DeepSeekTruncatedError, which callers
 *    treat as "skip this cycle" rather than as a bug.
 */
export async function structuredCompletion<T>(opts: StructuredOptions<T>): Promise<T> {
  if (!client) throw new DeepSeekUnavailableError();

  const model = opts.reasoning ? env.DEEPSEEK_MODEL_REASONER : env.DEEPSEEK_MODEL_CHAT;
  const maxAttempts = Math.min(
    opts.maxAttempts ?? MAX_STRUCTURED_ATTEMPTS,
    MAX_STRUCTURED_ATTEMPTS,
  );

  // max_tokens covers chain-of-thought AND the answer. deepseek-reasoner writes the
  // thinking first, so a chat-sized budget is spent before `content` begins and the
  // call returns "" with finish_reason "length". Reasoning calls need real headroom —
  // but a FIXED amount of it: this budget is the same on every attempt.
  const tokenBudget = opts.reasoning
    ? resolveTokenBudget(true, opts.maxTokens)
    : (opts.maxTokens ?? 1200);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  let lastError = "";
  let truncated = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    truncated = false;

    const res = await client.chat.completions.create({
      model,
      messages,
      response_format: { type: "json_object" },
      ...(opts.reasoning ? {} : { temperature: opts.temperature ?? 0.2 }),
      max_tokens: tokenBudget,
    });

    const choice = res.choices[0];
    const raw = choice?.message?.content ?? "";

    try {
      // An empty answer is not a malformed-JSON problem, and reporting it as one hides
      // the cause. deepseek-reasoner spends the max_tokens budget on chain-of-thought
      // before it writes `content`, so a budget that runs out arrives here as "" with
      // finish_reason "length" and nothing to parse.
      if (raw.trim() === "") {
        const reasoningTokens = (
          res.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined
        )?.completion_tokens_details?.reasoning_tokens;
        truncated = true;
        throw new Error(
          `empty completion (model=${model}, finish_reason=${choice?.finish_reason ?? "unknown"}` +
            (reasoningTokens === undefined ? "" : `, reasoning_tokens=${reasoningTokens}`) +
            `, max_tokens=${tokenBudget})`,
        );
      }

      const parsed = opts.schema.parse(JSON.parse(extractJsonBlock(raw)));
      return parsed;
    } catch (err) {
      lastError =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
          : err instanceof Error
            ? err.message
            : String(err);

      console.warn(`[deepseek] structured output attempt ${attempt} failed: ${lastError}`);

      // Nothing came back to correct, so there is no repair message to add; the retry
      // is a plain re-roll on the same fixed budget. Growing the budget here is what
      // this change removed — see REASONER_MAX_TOKENS.
      if (attempt < maxAttempts && !truncated) {
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content:
            `Your previous response failed schema validation: ${lastError}. ` +
            `Respond again with ONLY a valid JSON object matching the required schema. No prose.`,
        });
      }
    }
  }

  if (truncated) throw new DeepSeekTruncatedError(`${maxAttempts} attempts; ${lastError}`);
  throw new Error(`[deepseek] structured output failed after ${maxAttempts} attempts: ${lastError}`);
}
