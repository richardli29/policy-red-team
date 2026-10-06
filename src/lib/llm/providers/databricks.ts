import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { longRunningTransport } from './transport';
import type { CatalogueEntry, ProviderConfig, ProviderDefinition } from './types';

/**
 * DATABRICKS FOUNDATION MODELS, through Unity Gateway.
 *
 * TWO SURFACES, chosen by the shape of the model name:
 *
 *   system.ai.claude-sonnet-5   A Unity Gateway model service: a Unity Catalog
 *                               securable, three dotted parts, called at
 *                               `<workspace>/ai-gateway/mlflow/v1`. Access is
 *                               EXECUTE on the service; rate limits, usage
 *                               tracking, inference tables and service policies
 *                               are Unity Gateway's. This is the default.
 *   databricks-claude-sonnet-5  A workspace serving endpoint, called at
 *                               `<workspace>/serving-endpoints`, where the model
 *                               is the endpoint name and access is CAN_QUERY.
 *
 * Both are OpenAI-compatible and, measured on 2026-10-06, behave identically
 * for Claude: JSON mode refused, JSON fenced, errors as `{error_code,
 * message}`. So everything below applies to either; only the base URL differs.
 * This module only has to arrive with a credential the service will accept.
 *
 * TWO WAYS IN, and the first needs nothing typed:
 *
 *   service-principal   OAuth client credentials. Inside Databricks Apps the
 *                       platform injects `DATABRICKS_CLIENT_ID` and
 *                       `DATABRICKS_CLIENT_SECRET` for the app's own principal,
 *                       and granting that principal EXECUTE on the model service (or CAN_QUERY on an endpoint) is
 *                       the whole of the access story.
 *   token               A personal access token, for running this on a laptop
 *                       against a workspace. Not for a deployment: it is a
 *                       person's credential and it expires with them.
 *
 * THE TOKEN IS CACHED AND REFRESHED EARLY, for the reason `entra.ts` gives: the
 * SDK asks for the key on every request and a run makes hundreds of them.
 */

const EARLY_REFRESH_MS = 60_000;
const TOKEN_TIMEOUT_MS = 15_000;

type AuthMode = 'service-principal' | 'token';

const mode = (config: ProviderConfig): AuthMode =>
  config.authMode?.trim() === 'token' ? 'token' : 'service-principal';

/**
 * The workspace origin, from whatever an operator or the platform supplied.
 *
 * Databricks Apps injects `DATABRICKS_HOST` as a bare hostname, the CLI's
 * profiles carry a full URL, and a reader pastes the browser's address bar with
 * `?o=<workspace id>` on the end. All three are the same workspace.
 */
export function normaliseHost(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

type Cached = { token: string; expiresAt: number };
const cache = new Map<string, Cached>();

/** Dropped between tests, and whenever configuration changes underneath. */
export function clearDatabricksTokenCache(): void {
  cache.clear();
}

/**
 * A bearer token for this configuration, or a function that fetches one.
 *
 * Errors carry the workspace's own words. `invalid_client` is a wrong secret and
 * the fix is in the app's configuration, not in the network — which is exactly
 * what a bare "could not authenticate" would hide.
 */
export function databricksToken(config: ProviderConfig): string | (() => Promise<string>) {
  if (mode(config) === 'token') return config.token.trim();
  const host = normaliseHost(config.host)!;
  const clientId = config.clientId.trim();
  const clientSecret = config.clientSecret.trim();
  const key = `${host}:${clientId}:${clientSecret}`;

  return async () => {
    const hit = cache.get(key);
    if (hit && hit.expiresAt - EARLY_REFRESH_MS > Date.now()) return hit.token;

    const response = await fetch(`${host}/oidc/v1/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `The workspace refused to issue a token for the service principal (${response.status}): ${(await response.text()).slice(0, 400)}`,
      );
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('The workspace answered without a token.');
    const fresh = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
    cache.set(key, fresh);
    return fresh.token;
  };
}

/** Unity Gateway's OpenAI-compatible surface, for a model service. */
export const UNITY_GATEWAY_PATH = '/ai-gateway/mlflow/v1';

/** A Unity Catalog name has three dotted parts; an endpoint name has none. */
export function isModelService(model: string | undefined): boolean {
  return /^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(model?.trim() ?? '');
}

export function baseUrlFor(host: string, model: string | undefined): string {
  return isModelService(model) ? `${host}${UNITY_GATEWAY_PATH}` : `${host}/serving-endpoints`;
}

export const databricks: ProviderDefinition = {
  id: 'databricks',
  label: 'Databricks (Unity Gateway)',
  blurb:
    'A foundation model in your Databricks workspace, through Unity Gateway: a system.ai model, a model service of your own, or a serving endpoint. Access, rate limits, usage tracking and guardrails are governed in Unity Catalog, and calls bill to the workspace.',
  egress: ['your Databricks workspace host (Unity Gateway or model serving, and its OAuth token endpoint)'],
  fields: [
    {
      name: 'host',
      label: 'Workspace URL',
      hint: 'The address of the workspace. Inside Databricks Apps this is set for you.',
      placeholder: 'https://my-workspace.cloud.databricks.com',
    },
    {
      name: 'model',
      label: 'Model',
      hint: 'A Unity Gateway model service such as system.ai.claude-sonnet-5, or a serving endpoint name such as databricks-claude-sonnet-5.',
      placeholder: 'system.ai.claude-sonnet-5',
    },
    {
      name: 'authMode',
      label: 'How to authenticate',
      hint: 'A deployment uses its service principal. A token is for trying this from a laptop.',
      kind: 'select',
      options: [
        { value: 'service-principal', text: 'Service principal (OAuth) — what Databricks Apps provides' },
        { value: 'token', text: 'Personal access token' },
      ],
    },
    {
      name: 'clientId',
      label: 'Client ID',
      hint: 'The service principal’s application ID. Inside Databricks Apps this is set for you.',
      showWhen: { field: 'authMode', is: ['service-principal'] },
    },
    {
      name: 'clientSecret',
      label: 'Client secret',
      hint: 'An OAuth secret for that service principal. Inside Databricks Apps this is set for you.',
      secret: true,
      showWhen: { field: 'authMode', is: ['service-principal'] },
    },
    {
      name: 'token',
      label: 'Access token',
      hint: 'From User settings → Developer → Access tokens. Starts dapi.',
      secret: true,
      showWhen: { field: 'authMode', is: ['token'] },
    },
  ],

  problem: (config) => {
    if (!config.host?.trim()) return 'Say which workspace.';
    if (!normaliseHost(config.host)) return 'The workspace URL has to be https.';
    if (!config.model?.trim()) return 'Say which model to call.';
    if (mode(config) === 'token') return config.token?.trim() ? null : 'Put an access token in.';
    if (!config.clientId?.trim()) return 'Put the service principal’s client ID in.';
    if (!config.clientSecret?.trim()) return 'Put the service principal’s client secret in.';
    return null;
  },

  model: (config) => config.model.trim(),

  client: (config) => {
    // Long-context stages on a pay-per-token endpoint are measured in minutes,
    // and the wire must outlast the deadline above it. See `transport.ts`.
    const transport = longRunningTransport();
    return adaptParameters(
      new OpenAI({
        baseURL: baseUrlFor(normaliseHost(config.host)!, config.model),
        apiKey: databricksToken(config),
        ...transport,
        fetch: readableErrors(transport.fetch),
        maxRetries: 0,
      }),
    );
  },

  models: (config) =>
    config.model?.trim()
      ? [
          {
            id: config.model.trim(),
            name: config.model.trim(),
            note: isModelService(config.model)
              ? 'Through Unity Gateway. The model service decides what answers.'
              : 'Your serving endpoint. Whatever model is behind it is what answers.',
          },
        ]
      : [],

  /*
   * THE WORKSPACE'S CHAT ENDPOINTS, so the reader picks a name rather than
   * guessing its spelling. It needs the credential and the host, not a model —
   * which is the point at which it is needed.
   */
  catalogue: async (config) => {
    const token = databricksToken(config);
    const bearer = typeof token === 'string' ? token : await token();
    const response = await fetch(`${normaliseHost(config.host)}/api/2.0/serving-endpoints`, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`The workspace would not list its serving endpoints (${response.status}): ${(await response.text()).slice(0, 400)}`);
    }
    const body = (await response.json()) as { endpoints?: { name: string; task?: string; state?: { ready?: string } }[] };
    return (body.endpoints ?? [])
      .filter((e) => e.task === 'llm/v1/chat')
      .map((e): CatalogueEntry => ({
        id: e.name,
        name: e.name,
        description: e.state?.ready === 'READY' ? 'Ready.' : `Not ready (${e.state?.ready ?? 'unknown'}).`,
        contextLength: null,
        // Billed to the workspace in DBUs; nothing per token is quoted here.
        promptCost: null,
        completionCost: null,
        floating: false,
      }));
  },

  /*
   * NO `grounded`. Model Serving has no web search on this API, and a model
   * answering a research question from memory would put invented sources in an
   * assessment. Configure Tavily, or `POLICY_SEARCH=none`.
   */

  // Long enough for Claude to write CLAUDE_RETRY_MAX_TOKENS — the budget a
  // request gets after it was once cut off — at the measured rate, and short of
  // `transport.ts`'s 720-second wire limit, which would otherwise decide first
  // and report it as the endpoint being unreachable.
  callTimeoutMs: 660_000,
};

/**
 * DATABRICKS' ERRORS, IN THE SHAPE THE SDK READS.
 *
 * Model Serving answers a refusal with `{"error_code": …, "message": …}`. The
 * OpenAI SDK only reads `{"error": {…}}`, so it discarded the explanation and
 * reported every refusal as "400 status code (no body)" — measured 2026-09-24
 * with the raw response captured beside it. That put an unreadable reason in the
 * call audit for every failure on the first two runs, and it is why the
 * adapter below had to guess at what an endpoint refused. Reshaping the body
 * gives the SDK — and the reader — the endpoint's own words.
 */
export function readableErrors(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const response = await inner(input, init);
    if (response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return response;
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const shaped =
      body && typeof body === 'object' && !('error' in body) && ('error_code' in body || 'message' in body)
        ? (() => {
            const { error_code: code, message } = body as { error_code?: string; message?: string };
            return { error: { message: message || code || 'The endpoint refused the request.', code: code ?? null, type: code ?? null } };
          })()
        : body;
    // The body has been read and decoded: the length and encoding headers
    // describe the bytes that came off the wire, not these.
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(shaped === null ? text : JSON.stringify(shaped), { status: response.status, statusText: response.statusText, headers });
  }) as typeof globalThis.fetch;
}

/**
 * WHAT THE PIPELINE SENDS, IN THE SHAPE MODEL SERVING ACCEPTS — AND BACK.
 *
 * `provider.ts` is a copied file. It sends every call the same way, and these
 * things about that way are wrong for Model Serving, each measured against
 * a Databricks workspace on 2026-09-24:
 *
 *   `reasoning: { effort }`   OpenRouter's field, sent because a bare endpoint
 *                             name reads as an OpenRouter model. Serving takes
 *                             `reasoning_effort`, on the OpenAI reasoning
 *                             families only; Claude answers it with "Extra
 *                             inputs are not permitted".
 *   `response_format:         Refused by every Claude endpoint ("Response format
 *    json_object`             type json_object is not supported for this
 *                             model"), accepted by the GPT, gpt-oss, Gemini,
 *                             Llama, Qwen, GLM, DeepSeek and Kimi ones. So it is
 *                             dropped for Claude — and Claude then answers in a
 *                             ```json fence, which the pipeline cannot parse:
 *                             four stage-two calls in five failed on the first
 *                             real run. A fenced or prefaced reply to a request
 *                             that asked for JSON is unwrapped to the object.
 *                             (`json_schema` with an open schema was tried too;
 *                             Claude then invents a wrapper key — `args`,
 *                             `response` — around the whole answer.)
 *   `max_tokens: 25000`       The pipeline's one cap for every call. Claude on
 *                             Serving thinks inside the reply, so its reasoning
 *                             spends the same budget: every call that failed on
 *                             the first two real runs stopped at exactly 25,000,
 *                             and the final stage of both was lost to it. Claude
 *                             is given 48,000, and 64,000 for a request that was
 *                             once cut off — see `Truncations`.
 *   `content` as parts        Gemini answers with `[{ type: 'text', text }]`,
 *                             and Claude with a `reasoning` part before its
 *                             text, where every caller reads a string.
 *   usage                     Serving reports `cache_read_input_tokens`; the
 *                             audit reads `prompt_tokens_details.cached_tokens`
 *                             and so recorded 0% cached whatever happened.
 *
 * A REFUSAL IS OBEYED WHEN IT CAN BE READ (see `readableErrors`), and a bare
 * 400 still gets ONE blind retry per field, remembered for the life of this
 * client.
 */
// `.` too: a Unity Gateway name is `system.ai.claude-sonnet-5`.
const REASONING_FAMILIES = /(^|[-/.])(gpt-5|gpt-oss|o\d)/i;
const NO_JSON_MODE = /(^|[-/.])claude/i;
const CLAUDE = NO_JSON_MODE;
export const CLAUDE_MAX_TOKENS = 48_000;
/** ~580 seconds at the ~110 tokens a second measured on the first real runs. */
export const CLAUDE_RETRY_MAX_TOKENS = 64_000;
/** A shared prefix shorter than this is not worth a cache write. */
const CACHE_MIN_PREFIX = 4_000;

type Learned = { dropEffort: boolean; dropFormat: boolean };
type Extra = {
  /** This request, or one on the same base, was cut off before: give it more room. */
  escalate?: boolean;
  /** Characters of the first user message to mark as a cacheable prefix. */
  cachePrefix?: number;
};

type Message = { role: string; content: unknown };

export function rewriteBody(body: Record<string, unknown>, learned: Learned, extra: Extra = {}): Record<string, unknown> {
  const { reasoning, ...rest } = body as { reasoning?: { effort?: unknown } } & Record<string, unknown>;
  const out: Record<string, unknown> = rest;
  const model = String(body.model ?? '');
  const effort = reasoning && typeof reasoning === 'object' ? reasoning.effort : undefined;
  if (typeof effort === 'string' && REASONING_FAMILIES.test(model)) out.reasoning_effort = effort;
  if (learned.dropEffort) delete out.reasoning_effort;
  if (learned.dropFormat || NO_JSON_MODE.test(model)) delete out.response_format;
  if (CLAUDE.test(model) && typeof out.max_tokens === 'number') {
    const floor = extra.escalate ? CLAUDE_RETRY_MAX_TOKENS : CLAUDE_MAX_TOKENS;
    if (out.max_tokens < floor) out.max_tokens = floor;
  }
  if (CLAUDE.test(model) && extra.cachePrefix && extra.cachePrefix >= CACHE_MIN_PREFIX && Array.isArray(out.messages)) {
    out.messages = markPrefix(out.messages as Message[], extra.cachePrefix);
  }
  return out;
}

/**
 * The first user message split in two, with a cache breakpoint on the part it
 * shares with the previous request. A prompt cache matches a leading prefix up
 * to a breakpoint, and everything before it — the system prompt included — is
 * what a later call can read back. Nothing is changed but the shape.
 */
function markPrefix(messages: Message[], at: number): Message[] {
  const index = messages.findIndex((m) => m.role === 'user' && typeof m.content === 'string');
  if (index < 0) return messages;
  const text = messages[index].content as string;
  if (at >= text.length) return messages;
  const copy = messages.slice();
  copy[index] = {
    role: 'user',
    content: [
      { type: 'text', text: text.slice(0, at), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: text.slice(at) },
    ],
  };
  return copy;
}

/** How many leading characters two strings share. */
export function sharedPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * A reply's content as the string every caller reads, whatever shape it came in.
 *
 * With `wantsJson`, a reply that is not JSON as it stands but carries one — in a
 * code fence, or after a sentence of preamble — is reduced to that object. Only
 * a candidate that actually parses replaces the text: anything else is left
 * alone for the pipeline's repair round, which says what was wrong.
 */
export function flattenContent(result: unknown, wantsJson = false): unknown {
  const choices = (result as { choices?: { message?: { content?: unknown } }[] })?.choices;
  for (const choice of choices ?? []) {
    const message = choice.message;
    if (!message) continue;
    if (Array.isArray(message.content)) {
      message.content = message.content
        .map((part: { type?: string; text?: unknown }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('');
    }
    if (wantsJson && typeof message.content === 'string') message.content = jsonWithin(message.content);
  }
  normaliseUsage(result);
  return result;
}

/** Serving's cache figure, where the audit in `client.ts` looks for it. */
export function normaliseUsage(result: unknown): void {
  const usage = (result as { usage?: Record<string, unknown> })?.usage;
  if (!usage) return;
  const read = usage.cache_read_input_tokens;
  if (typeof read !== 'number') return;
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  if (typeof details.cached_tokens !== 'number') usage.prompt_tokens_details = { ...details, cached_tokens: read };
}

function jsonWithin(text: string): string {
  const parses = (candidate: string) => {
    try {
      JSON.parse(candidate);
      return true;
    } catch {
      return false;
    }
  };
  const trimmed = text.trim();
  if (parses(trimmed)) return text;
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(trimmed)?.[1]?.trim();
  if (fenced && parses(fenced)) return fenced;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start && parses(trimmed.slice(start, end + 1))) return trimmed.slice(start, end + 1);
  return text;
}

/**
 * REQUESTS THAT WERE CUT OFF, so the next attempt is not a copy of the last.
 *
 * A reply that runs out of `max_tokens` is deterministic: sent again with the
 * same budget it stops in the same place. On the first real runs the final
 * stage was attempted three times with ~197,000 input tokens each and failed
 * identically every time — about a million input tokens across both runs for
 * nothing. A request is recognised by its BASE — the model, the system prompt
 * and the first user message — so both a repair round (which appends to the
 * conversation) and the stage's own retry (which rebuilds it) get more room.
 *
 * Module-wide rather than per client: the client is rebuilt whenever the
 * configuration is read differently, and a retry must not forget. Bounded,
 * oldest first out.
 */
const TRUNCATED_LIMIT = 200;
const truncations = new Map<string, true>();

export function baseKey(body: Record<string, unknown>): string {
  const messages = (body.messages as Message[] | undefined) ?? [];
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  return createHash('sha256').update(JSON.stringify([body.model ?? '', system, user])).digest('hex');
}

export function rememberTruncation(key: string): void {
  truncations.delete(key);
  truncations.set(key, true);
  while (truncations.size > TRUNCATED_LIMIT) truncations.delete(truncations.keys().next().value!);
}

export function wasTruncated(key: string): boolean {
  return truncations.has(key);
}

export function clearTruncations(): void {
  truncations.clear();
}

/** Prompt caching is an experiment until a real run shows it saves more than it costs. */
const promptCacheOn = () => process.env.POLICY_DATABRICKS_PROMPT_CACHE?.trim() === '1';

/**
 * ONE LINE PER CALL, for `databricks apps logs`. Until this, the log said the
 * server had started and nothing else for the next two hours.
 */
function logCall(model: string, startedAt: number, result: unknown, error?: unknown): void {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
  if (error) {
    const status = (error as { status?: number })?.status ?? '-';
    const message = error instanceof Error ? error.message : String(error);
    console.log(`serving: ${model} failed after ${secs}s (${status}) ${message.slice(0, 240)}`);
    return;
  }
  const usage = (result as { usage?: Record<string, unknown> })?.usage ?? {};
  const finish = (result as { choices?: { finish_reason?: string }[] })?.choices?.[0]?.finish_reason ?? '-';
  console.log(
    `serving: ${model} ${secs}s in=${usage.prompt_tokens ?? '-'} out=${usage.completion_tokens ?? '-'} ` +
      `cached=${usage.cache_read_input_tokens ?? 0} written=${usage.cache_creation_input_tokens ?? 0} finish=${finish}`,
  );
}

function adaptParameters(client: OpenAI): OpenAI {
  const completions = client.chat.completions;
  const create = completions.create.bind(completions);
  const learned: Learned = { dropEffort: false, dropFormat: false };
  /** The last first-user-message sent per model and system prompt, for the cache prefix. */
  const previous = new Map<string, string>();

  completions.create = (async (body: Parameters<typeof create>[0], options?: Parameters<typeof create>[1]) => {
    const raw = body as unknown as Record<string, unknown>;
    const model = String(raw.model ?? '');
    const key = baseKey(raw);
    const extra: Extra = { escalate: wasTruncated(key) };

    if (promptCacheOn() && CLAUDE.test(model)) {
      const messages = (raw.messages as Message[] | undefined) ?? [];
      const system = String(messages.find((m) => m.role === 'system')?.content ?? '');
      const user = messages.find((m) => m.role === 'user')?.content;
      if (typeof user === 'string') {
        const slot = createHash('sha256').update(`${model}\u0000${system}`).digest('hex');
        const last = previous.get(slot);
        if (last) extra.cachePrefix = sharedPrefix(last, user);
        previous.set(slot, user);
        if (previous.size > 50) previous.delete(previous.keys().next().value!);
      }
    }

    const wantsJson = (raw.response_format as { type?: string } | undefined)?.type === 'json_object';
    for (;;) {
      const sent = rewriteBody(raw, learned, extra);
      const startedAt = Date.now();
      try {
        const result = flattenContent(await create(sent as unknown as typeof body, options), wantsJson);
        logCall(model, startedAt, result);
        if ((result as { choices?: { finish_reason?: string }[] }).choices?.[0]?.finish_reason === 'length') rememberTruncation(key);
        return result;
      } catch (err) {
        logCall(model, startedAt, null, err);
        if ((err as { status?: number })?.status !== 400) throw err;
        const message = err instanceof Error ? err.message : '';
        const bare = !message || /no body/i.test(message);
        if (!learned.dropEffort && 'reasoning_effort' in sent && (bare || /reasoning_effort/i.test(message))) learned.dropEffort = true;
        else if (!learned.dropFormat && 'response_format' in sent && (bare || /response.format/i.test(message))) learned.dropFormat = true;
        else throw err;
      }
    }
  }) as typeof completions.create;

  return client;
}
