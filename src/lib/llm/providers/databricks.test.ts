import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseKey, CLAUDE_MAX_TOKENS, CLAUDE_RETRY_MAX_TOKENS, clearDatabricksTokenCache, clearTruncations, databricks, databricksToken, flattenContent, normaliseHost, readableErrors, rewriteBody, sharedPrefix } from './databricks';

/**
 * DATABRICKS MODEL SERVING, proved without a workspace.
 *
 * What is asserted is what goes on the wire: the URL a chat call is built
 * against, the token grant a service principal makes, and the body the copied
 * pipeline's OpenRouter-shaped request becomes. The endpoint's own behaviour is
 * the workspace's business and is checked against a real one by hand.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearDatabricksTokenCache();
  clearTruncations();
  delete process.env.POLICY_DATABRICKS_PROMPT_CACHE;
});

const sp = { host: 'fevm-x.cloud.databricks.com', model: 'databricks-claude-sonnet-4-5', clientId: 'id', clientSecret: 'secret' };

describe('what Databricks needs before it can be tried', () => {
  it('names the missing field', () => {
    expect(databricks.problem({})).toMatch(/workspace/i);
    expect(databricks.problem({ host: 'http://x.cloud.databricks.com' })).toMatch(/https/i);
    expect(databricks.problem({ host: sp.host })).toMatch(/endpoint/i);
    expect(databricks.problem({ host: sp.host, model: sp.model })).toMatch(/client ID/i);
    expect(databricks.problem({ host: sp.host, model: sp.model, clientId: 'id' })).toMatch(/secret/i);
    expect(databricks.problem(sp)).toBeNull();
  });

  it('asks for a token, and only a token, when that is the chosen way in', () => {
    expect(databricks.problem({ host: sp.host, model: sp.model, authMode: 'token' })).toMatch(/token/i);
    expect(databricks.problem({ host: sp.host, model: sp.model, authMode: 'token', token: 'dapi1' })).toBeNull();
  });
});

describe('which workspace', () => {
  it('reads a bare host, a URL and a pasted address bar as the same workspace', () => {
    // Databricks Apps injects the first; a browser tab gives the last.
    expect(normaliseHost('fevm-x.cloud.databricks.com')).toBe('https://fevm-x.cloud.databricks.com');
    expect(normaliseHost('https://fevm-x.cloud.databricks.com/')).toBe('https://fevm-x.cloud.databricks.com');
    expect(normaliseHost('https://fevm-x.cloud.databricks.com/?o=7474654706714892')).toBe('https://fevm-x.cloud.databricks.com');
    expect(normaliseHost('')).toBeNull();
  });

  it('calls the serving endpoints under that workspace, by endpoint name', () => {
    const client = databricks.client(sp);
    expect(client.baseURL).toBe('https://fevm-x.cloud.databricks.com/serving-endpoints');
    expect(databricks.model(sp)).toBe('databricks-claude-sonnet-4-5');
    expect(databricks.models(sp).map((m) => m.id)).toEqual(['databricks-claude-sonnet-4-5']);
  });
});

describe('the service principal token', () => {
  it('is a client-credentials grant against the workspace, cached until near expiry', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: 'sp-token', expires_in: 3600 }), { status: 200 });
    });

    const token = databricksToken(sp);
    expect(typeof token).toBe('function');
    expect(await (token as () => Promise<string>)()).toBe('sp-token');
    expect(await (token as () => Promise<string>)()).toBe('sp-token');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://fevm-x.cloud.databricks.com/oidc/v1/token');
    expect(String(calls[0].init.body)).toBe('grant_type=client_credentials&scope=all-apis');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
  });

  it('carries the workspace’s own refusal, not a paraphrase', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"invalid_client"}', { status: 401 }));
    await expect((databricksToken(sp) as () => Promise<string>)()).rejects.toThrow(/401.*invalid_client/);
  });

  it('passes a personal token straight through', () => {
    expect(databricksToken({ ...sp, authMode: 'token', token: ' dapi1 ' })).toBe('dapi1');
  });
});

describe('what the pipeline sends, rewritten for Model Serving', () => {
  const none = { dropEffort: false, dropFormat: false };

  it('drops OpenRouter’s reasoning object and JSON mode for Claude, which refuses both', () => {
    const out = rewriteBody({ model: 'databricks-claude-sonnet-5', reasoning: { effort: 'high' }, response_format: { type: 'json_object' }, max_tokens: 25_000 }, none);
    expect(out).toEqual({ model: 'databricks-claude-sonnet-5', max_tokens: CLAUDE_MAX_TOKENS });
  });

  it('gives Claude room for the reasoning it writes inside the reply, and leaves other families alone', () => {
    expect(rewriteBody({ model: 'databricks-claude-sonnet-5', max_tokens: 25_000 }, none).max_tokens).toBe(48_000);
    // Never lowered: a caller that asked for more keeps it.
    expect(rewriteBody({ model: 'databricks-claude-sonnet-5', max_tokens: 60_000 }, none).max_tokens).toBe(60_000);
    expect(rewriteBody({ model: 'databricks-gpt-5-5', max_tokens: 25_000 }, none).max_tokens).toBe(25_000);
  });

  it('allows a call long enough to write the escalated budget, short of the wire’s own limit', () => {
    // ~110 tokens a second was measured; the transport gives up at 720 s.
    expect(databricks.callTimeoutMs).toBeGreaterThan((CLAUDE_RETRY_MAX_TOKENS / 110) * 1000);
    expect(databricks.callTimeoutMs).toBeLessThan(720_000);
  });

  it('gives a request that was once cut off more room, and only Claude', () => {
    expect(rewriteBody({ model: 'databricks-claude-sonnet-5', max_tokens: 25_000 }, none, { escalate: true }).max_tokens).toBe(CLAUDE_RETRY_MAX_TOKENS);
    expect(rewriteBody({ model: 'databricks-gpt-5-5', max_tokens: 25_000 }, none, { escalate: true }).max_tokens).toBe(25_000);
  });

  it('keeps JSON mode for the families that take it', () => {
    for (const model of ['databricks-gpt-5-5', 'databricks-gemini-3-5-flash', 'databricks-llama-4-maverick', 'databricks-kimi-k3']) {
      expect(rewriteBody({ model, response_format: { type: 'json_object' } }, none)).toEqual({ model, response_format: { type: 'json_object' } });
    }
  });

  it('turns reasoning into reasoning_effort for the OpenAI reasoning families', () => {
    expect(rewriteBody({ model: 'databricks-gpt-5', reasoning: { effort: 'low' } }, none)).toEqual({ model: 'databricks-gpt-5', reasoning_effort: 'low' });
    expect(rewriteBody({ model: 'databricks-gpt-oss-120b', reasoning: { effort: 'medium' } }, none)).toEqual({ model: 'databricks-gpt-oss-120b', reasoning_effort: 'medium' });
  });

  it('drops the off switch, which has no Model Serving equivalent', () => {
    expect(rewriteBody({ model: 'databricks-gpt-5', reasoning: { enabled: false } }, none)).toEqual({ model: 'databricks-gpt-5' });
  });

  it('keeps only the text of a Claude reply that carries its reasoning, and unwraps the fence around its JSON', () => {
    // The shape databricks-claude-sonnet-5 returned on 2026-09-24.
    const result = { choices: [{ message: { content: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '', signature: 'Ep…' }] },
      { type: 'text', text: '```json\n{\n  "claims": [{ "id": "C1" }]\n}\n```' },
    ] } }] };
    expect((flattenContent(result, true) as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe('{\n  "claims": [{ "id": "C1" }]\n}');
  });

  it('finds the object after a sentence of preamble, and leaves text that holds none alone', () => {
    const wrap = (content: string) => ({ choices: [{ message: { content } }] });
    const read = (r: unknown) => (r as { choices: { message: { content: string } }[] }).choices[0].message.content;
    expect(read(flattenContent(wrap('Here it is: {"ok": true} Hope that helps.'), true))).toBe('{"ok": true}');
    expect(read(flattenContent(wrap('I cannot do that {not json}'), true))).toBe('I cannot do that {not json}');
    // Not asked for JSON: prose is prose.
    expect(read(flattenContent(wrap('```json\n{}\n```'), false))).toBe('```json\n{}\n```');
  });

  it('flattens a reply in parts, as Gemini sends one, into the string callers read', () => {
    const result = { choices: [{ message: { content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: ' true}' }] } }] };
    expect((flattenContent(result) as typeof result).choices[0].message.content).toBe('{"ok": true}');
  });

  it('retries a bodiless 400 once per droppable field, and remembers', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = databricks.client({ ...sp, authMode: 'token', token: 'dapi1', model: 'databricks-gpt-5' });
    const proto = Object.getPrototypeOf(client.chat.completions);
    const spy = vi.spyOn(proto, 'create').mockImplementation(async (body: unknown) => {
      bodies.push(body as Record<string, unknown>);
      // What the SDK actually reports for Model Serving's refusals.
      if ('response_format' in (body as object)) throw Object.assign(new Error('400 status code (no body)'), { status: 400 });
      return { choices: [{ message: { content: '{}' } }] };
    });
    // Built after the spy, so the adapted `create` binds to it.
    const adapted = databricks.client({ ...sp, authMode: 'token', token: 'dapi1', model: 'databricks-gpt-5' });
    const call = () => adapted.chat.completions.create({ model: 'databricks-gpt-5', messages: [], reasoning: { effort: 'low' }, response_format: { type: 'json_object' } } as never);
    await call();
    await call();
    // Effort dropped first (still refused), then the format (accepted); the
    // second call goes straight to what worked.
    expect(bodies.map((b) => [ 'reasoning_effort' in b, 'response_format' in b ])).toEqual([[true, true], [false, true], [false, false], [false, false]]);
    spy.mockRestore();
  });

  it('gives up with the endpoint’s own error once nothing is left to drop', async () => {
    const client = databricks.client({ ...sp, authMode: 'token', token: 'dapi1' });
    const spy = vi.spyOn(Object.getPrototypeOf(client.chat.completions), 'create').mockRejectedValue(Object.assign(new Error('400 status code (no body)'), { status: 400 }));
    const adapted = databricks.client({ ...sp, authMode: 'token', token: 'dapi1' });
    await expect(adapted.chat.completions.create({ model: sp.model, messages: [] } as never)).rejects.toThrow(/400/);
    spy.mockRestore();
  });
});

describe('what a refusal says', () => {
  // The body Model Serving sent on 2026-09-24, captured beside the SDK's
  // "400 status code (no body)".
  const refusal = () =>
    new Response(JSON.stringify({ error_code: 'INVALID_PARAMETER_VALUE', message: 'INVALID_PARAMETER_VALUE: Response format type json_object is not supported for this model.' }), {
      status: 400,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });

  it('reshapes Databricks’ error body into the one the SDK reads', async () => {
    const res = await readableErrors(async () => refusal())('https://x/serving-endpoints/chat/completions');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.json()).toEqual({ error: { message: 'INVALID_PARAMETER_VALUE: Response format type json_object is not supported for this model.', code: 'INVALID_PARAMETER_VALUE', type: 'INVALID_PARAMETER_VALUE' } });
  });

  it('leaves a success, and a body already in the SDK’s shape, alone', async () => {
    const ok = new Response('{"choices":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await readableErrors(async () => ok)('u')).toBe(ok);
    const shaped = await readableErrors(async () => new Response('{"error":{"message":"m"}}', { status: 429, headers: { 'content-type': 'application/json' } }))('u');
    expect(await shaped.json()).toEqual({ error: { message: 'm' } });
  });

  it('puts the endpoint’s own words in the error the pipeline records', async () => {
    // The SDK keeps the fetch it was given on the client; stand in for the wire.
    const reading = databricks.client({ ...sp, authMode: 'token', token: 'dapi1' });
    (reading as unknown as { fetch: unknown }).fetch = readableErrors(async () => refusal());
    await expect(reading.chat.completions.create({ model: 'databricks-gpt-5-5', messages: [{ role: 'user', content: 'x' }] } as never)).rejects.toThrow(/Response format type json_object is not supported/);
  });
});

describe('acting on a readable refusal', () => {
  const refuse = (message: string) => Object.assign(new Error(message), { status: 400 });

  it('drops the field the endpoint named, and throws a refusal that names neither', async () => {
    const bodies: Record<string, unknown>[] = [];
    const proto = Object.getPrototypeOf(databricks.client({ ...sp, authMode: 'token', token: 'dapi1' }).chat.completions);
    vi.spyOn(proto, 'create').mockImplementation(async (body: unknown) => {
      bodies.push(body as Record<string, unknown>);
      if ('response_format' in (body as object)) throw refuse('400 INVALID_PARAMETER_VALUE: Response format type json_object is not supported');
      return { choices: [{ message: { content: '{}' } }] };
    });
    const adapted = databricks.client({ ...sp, authMode: 'token', token: 'dapi1' });
    await adapted.chat.completions.create({ model: 'databricks-gpt-5', messages: [], reasoning: { effort: 'low' }, response_format: { type: 'json_object' } } as never);
    // Named the format, so effort was kept: two sends, not three.
    expect(bodies.map((b) => ['reasoning_effort' in b, 'response_format' in b])).toEqual([[true, true], [true, false]]);

    vi.spyOn(proto, 'create').mockRejectedValue(refuse('400 BAD_REQUEST: messages: too many'));
    const other = databricks.client({ ...sp, authMode: 'token', token: 'dapi1' });
    await expect(other.chat.completions.create({ model: 'databricks-gpt-5', messages: [], response_format: { type: 'json_object' } } as never)).rejects.toThrow(/too many/);
  });
});

describe('a request that was cut off', () => {
  it('is sent again with more room, recognised by its base whatever was appended', async () => {
    const budgets: unknown[] = [];
    const proto = Object.getPrototypeOf(databricks.client({ ...sp, authMode: 'token', token: 'dapi1' }).chat.completions);
    vi.spyOn(proto, 'create').mockImplementation(async (body: unknown) => {
      budgets.push((body as { max_tokens?: unknown }).max_tokens);
      return { choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] };
    });
    const adapted = databricks.client({ ...sp, authMode: 'token', token: 'dapi1' });
    const base = [{ role: 'system', content: 'contract' }, { role: 'user', content: 'the paper' }];
    await adapted.chat.completions.create({ model: sp.model, max_tokens: 25_000, messages: base } as never);
    // The pipeline's repair round appends; its stage retry rebuilds. Both are the same base.
    await adapted.chat.completions.create({ model: sp.model, max_tokens: 25_000, messages: [...base, { role: 'assistant', content: '{"a":' }, { role: 'user', content: 'fewer items' }] } as never);
    expect(budgets).toEqual([CLAUDE_MAX_TOKENS, CLAUDE_RETRY_MAX_TOKENS]);
    expect(baseKey({ model: sp.model, messages: base })).toBe(baseKey({ model: sp.model, messages: [...base, { role: 'user', content: 'more' }] }));
  });
});

describe('what the call audit is told about caching', () => {
  it('copies Serving’s cache figure to where the audit reads it', () => {
    const result = { choices: [], usage: { prompt_tokens: 15_492, cache_read_input_tokens: 15_475 } };
    flattenContent(result);
    expect((result.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens).toBe(15_475);
  });
});

describe('prompt caching, as an experiment', () => {
  const long = 'shared context '.repeat(600);

  it('marks nothing unless it is switched on', async () => {
    const sent: Record<string, unknown>[] = [];
    const proto = Object.getPrototypeOf(databricks.client({ ...sp, authMode: 'token', token: 'dapi1' }).chat.completions);
    vi.spyOn(proto, 'create').mockImplementation(async (body: unknown) => { sent.push(body as Record<string, unknown>); return { choices: [{ message: { content: '{}' } }] }; });
    const adapted = databricks.client({ ...sp, authMode: 'token', token: 'dapi1' });
    for (const tail of ['one', 'two']) await adapted.chat.completions.create({ model: sp.model, messages: [{ role: 'system', content: 's' }, { role: 'user', content: long + tail }] } as never);
    expect(sent.every((b) => typeof (b.messages as { content: unknown }[])[1].content === 'string')).toBe(true);
  });

  it('when on, puts a breakpoint at the prefix a request shares with the last one', async () => {
    process.env.POLICY_DATABRICKS_PROMPT_CACHE = '1';
    const sent: Record<string, unknown>[] = [];
    const proto = Object.getPrototypeOf(databricks.client({ ...sp, authMode: 'token', token: 'dapi1' }).chat.completions);
    vi.spyOn(proto, 'create').mockImplementation(async (body: unknown) => { sent.push(body as Record<string, unknown>); return { choices: [{ message: { content: '{}' } }] }; });
    const adapted = databricks.client({ ...sp, authMode: 'token', token: 'dapi1' });
    for (const tail of ['one', 'two']) await adapted.chat.completions.create({ model: sp.model, messages: [{ role: 'system', content: 's' }, { role: 'user', content: long + tail }] } as never);
    // The first has nothing to share with; the second marks exactly the shared part.
    expect(typeof (sent[0].messages as { content: unknown }[])[1].content).toBe('string');
    const parts = (sent[1].messages as { content: { text: string; cache_control?: unknown }[] }[])[1].content;
    expect(parts[0].text).toBe(long);
    expect(parts[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(parts[1].text).toBe('two');
    expect(sharedPrefix(long + 'one', long + 'two')).toBe(long.length);
  });
});
