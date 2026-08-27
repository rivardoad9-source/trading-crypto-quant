import axios, { AxiosError, type AxiosRequestConfig } from "axios";
import { HTTP_RETRIES, HTTP_TIMEOUT_MS } from "../config/constants.js";

const client = axios.create({
  timeout: HTTP_TIMEOUT_MS,
  headers: { Accept: "application/json", "User-Agent": "FlowMetrix/0.1 (paper-trading)" },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries on network errors and 5xx/429 only. 4xx is a caller bug and fails fast. */
function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = (err as AxiosError).response?.status;
  if (status === undefined) return true; // network / timeout
  return status === 429 || status >= 500;
}

export async function getJson<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= HTTP_RETRIES; attempt++) {
    try {
      const res = await client.get<T>(url, config);
      return res.data;
    } catch (err) {
      lastError = err;
      if (attempt === HTTP_RETRIES || !isRetryable(err)) break;
      await sleep(500 * 2 ** attempt);
    }
  }

  const detail = axios.isAxiosError(lastError)
    ? `${lastError.response?.status ?? "network"} ${lastError.message}`
    : String(lastError);
  throw new Error(`[http] GET ${url} failed: ${detail}`);
}

/**
 * Never throws. Returns `fallback` and logs a warning instead, so one dead upstream
 * cannot abort a whole research or trading cycle.
 */
export async function getJsonSafe<T>(
  url: string,
  fallback: T,
  config?: AxiosRequestConfig,
): Promise<T> {
  try {
    return await getJson<T>(url, config);
  } catch (err) {
    console.warn(`[http] soft-fail: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}
