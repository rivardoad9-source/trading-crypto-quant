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
    max_tokens: opts.maxTokens ?? 1500,
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
  /** Retries on parse/validation failure, feeding the error back to the model. */
  maxAttempts?: number;
}

/**
 * Requests JSON output and validates it against a Zod schema. On a validation
 * failure the error is fed back to the model so it can repair its own output.
 */
export async function structuredCompletion<T>(opts: StructuredOptions<T>): Promise<T> {
  if (!client) throw new DeepSeekUnavailableError();

  const model = opts.reasoning ? env.DEEPSEEK_MODEL_REASONER : env.DEEPSEEK_MODEL_CHAT;
  const maxAttempts = opts.maxAttempts ?? 2;

  // max_tokens covers chain-of-thought AND the answer. deepseek-reasoner writes the
  // thinking first, so a chat-sized budget is spent before `content` begins and the
  // call returns "" with finish_reason "length". Reasoning calls need real headroom.
  // 30 Agu: initial 4000 -> 8000 (observed: every reasoning call burned all 4000 tokens
  // on CoT, so attempt 1 always failed and a second call was always needed — doubling
  // the per-cycle cost; 8000 headroom lets most cycles finish in one call) and the
  // retry cap 8000 -> 16000 (occasional long CoT still hit the 8000 cap and aborted
  // the whole cycle with an empty completion).
  let tokenBudget = opts.maxTokens ?? (opts.reasoning ? 8000 : 1200);

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
        truncated = choice?.finish_reason === "length";
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

      if (attempt < maxAttempts) {
        if (truncated) {
          // Nothing was returned to correct, and repeating the call with the same
          // budget reproduces the truncation exactly. Give the next attempt room
          // instead of asking the model to repair an answer it never produced.
          tokenBudget = Math.min(tokenBudget * 2, 16000);
          console.warn(`[deepseek] retrying with max_tokens=${tokenBudget}`);
        } else {
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
  }

  throw new Error(`[deepseek] structured output failed after ${maxAttempts} attempts: ${lastError}`);
}
