import { IntegrationError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import type { IntegrationConfig } from '../config/types.js';

export interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * A small authenticated JSON client shared by both integrations.
 *
 * Retries transient failures with exponential backoff, honouring Retry-After
 * when the server sends one. Credentials are never included in thrown errors:
 * an integration failure gets reported with the URL and status, nothing more.
 */
export class HttpClient {
  private readonly authorization: string;

  constructor(
    private readonly integration: IntegrationConfig,
    private readonly baseUrl: string,
    private readonly logger: Logger,
  ) {
    const basic = Buffer.from(`${integration.username}:${integration.token}`).toString('base64');
    this.authorization = `Basic ${basic}`;
  }

  async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    // The URL is logged and thrown; a token in the query string would leak
    // into logs, so credentials only ever travel in the header.
    const safeUrl = `${url.origin}${url.pathname}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.integration.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const backoff = Math.min(2 ** attempt * 500, 8000);
        this.logger.debug(`retry ${attempt}/${this.integration.maxRetries} in ${backoff}ms — ${safeUrl}`);
        await sleep(backoff);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.integration.timeoutMs);

      try {
        const response = await fetch(url, {
          method: options.method ?? 'GET',
          headers: {
            authorization: this.authorization,
            accept: 'application/json',
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: controller.signal,
        });

        if (response.ok) {
          this.logger.debug(`${response.status} ${safeUrl}`);
          return await response.json() as T;
        }

        if (RETRYABLE_STATUS.has(response.status) && attempt < this.integration.maxRetries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter > 0) {
            this.logger.debug(`${response.status} — honouring Retry-After ${retryAfter}s`);
            await sleep(Math.min(retryAfter * 1000, 30_000));
          }
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }

        throw new IntegrationError(
          this.integration.id,
          `${this.integration.name}: ${safeUrl} answered ${response.status} ${response.statusText}`,
          response.status,
          this.hintForStatus(response.status),
        );
      } catch (error) {
        if (error instanceof IntegrationError) throw error;
        lastError = error as Error;
        const aborted = (error as Error).name === 'AbortError';
        if (attempt >= this.integration.maxRetries) {
          throw new IntegrationError(
            this.integration.id,
            aborted
              ? `${this.integration.name}: ${safeUrl} timed out after ${this.integration.timeoutMs}ms`
              : `${this.integration.name}: ${safeUrl} could not be reached (${lastError.message})`,
            undefined,
            aborted ? 'Raise timeout_ms for this integration if the endpoint is habitually slow.' : undefined,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw new IntegrationError(
      this.integration.id,
      `${this.integration.name}: ${safeUrl} failed after ${this.integration.maxRetries + 1} attempts (${lastError?.message ?? 'unknown'})`,
    );
  }

  private hintForStatus(status: number): string | undefined {
    if (status === 401) return 'Check the username and token for this integration.';
    if (status === 403) return 'The credentials are valid but lack access to this resource.';
    if (status === 404) return 'Check the workspace, repository slug or base_url.';
    return undefined;
  }
}
