// What each provider needs, and what it must never hand back.
//
// The client construction is asserted through the SDK's own `baseURL`, because
// the shape of an Azure call — deployment in the path, version in the query,
// `api-key` in the header — is the thing that is easy to get subtly wrong and
// impossible to notice until a real call 404s.
import { afterEach, describe, expect, it } from 'vitest';
import { azure } from './azure';
import { codex } from './codex';
import { openrouter } from './openrouter';
import { providerById, providers, redact } from './index';
import { coerceModelContext } from '$lib/constants/default-models';
import { isOfferedModel, registerProviderModels, registerProviderPinnedModel } from '$lib/server/models/catalogue';
import { commissionableModels, pinnedModel } from '$lib/server/models/offered-store';
import { DEFAULT_RESEARCH_DEEP_MODEL_ID, resolveResearchDeepModel } from '$lib/server/models/workload-settings';

const env = { ...process.env };
// The catalogue's registries are module variables. A pin left behind by one test
// changes what `isOfferedModel` answers in the next, so it is reset with the
// environment rather than per-describe.
afterEach(() => { process.env = { ...env }; registerProviderPinnedModel(null); });

describe('what a provider needs before it can be tried', () => {
  it('names the missing field rather than failing on the first call', () => {
    expect(openrouter.problem({})).toMatch(/key/i);
    expect(openrouter.problem({ apiKey: 'sk-or-x' })).toBeNull();

    expect(codex.problem({})).toMatch(/where/i);
    expect(codex.problem({ baseUrl: 'http://127.0.0.1:5207/v1' })).toMatch(/which model/i);
    expect(codex.problem({ baseUrl: 'http://127.0.0.1:5207/v1', model: 'gpt-5-codex' })).toBeNull();

    expect(azure.problem({ endpoint: 'https://r.openai.azure.com' })).toMatch(/deployment/i);
    expect(azure.problem({ endpoint: 'https://r.openai.azure.com', deployment: 'd' })).toMatch(/key/i);
    expect(azure.problem({ endpoint: 'https://r.openai.azure.com', deployment: 'd', apiKey: 'k' })).toBeNull();
  });

  it('refuses a base URL that is not one', () => {
    expect(codex.problem({ baseUrl: 'not a url', model: 'm' })).toMatch(/not a URL/i);
    // A `file:` or `ftp:` endpoint is not something to hand to an HTTP client.
    expect(codex.problem({ baseUrl: 'file:///etc/passwd', model: 'm' })).toMatch(/http/i);
    expect(azure.problem({ endpoint: 'http://r.openai.azure.com', deployment: 'd', apiKey: 'k' })).toMatch(/https/i);
  });

  it('treats a blank optional field as absent rather than as a value', () => {
    expect(codex.problem({ baseUrl: 'http://127.0.0.1:5207/v1', model: 'm', apiKey: '   ' })).toBeNull();
  });
});

describe('where the calls actually go', () => {
  it('puts an Azure deployment in the path and the version in the query', () => {
    // Azure's shape, and the one thing that is silently wrong until a real call
    // 404s: the deployment is part of the URL, not the model parameter alone.
    //
    // WHERE IT IS ADDED MOVED IN PHASE 18. This used to build the whole path
    // into `baseURL` by hand. It now uses the SDK's own `AzureOpenAI`, which
    // keeps `baseURL` at the resource and prepends `/deployments/<name>` when it
    // builds a chat-completions request (`node_modules/openai/azure.js`,
    // `buildRequest`). The URL that goes on the wire is the same; the object
    // holds it differently, and a test that only reads `baseURL` can no longer
    // see the deployment at all.
    const client = azure.client({
      endpoint: 'https://my-resource.openai.azure.com/',
      deployment: 'gpt-5-policy',
      apiKey: 'secret',
    });
    expect(client.baseURL).toBe('https://my-resource.openai.azure.com/openai');
    // `client()` is typed as the plain `OpenAI` the registry contract promises,
    // so the Azure-only fields need naming. They are public on `AzureOpenAI`,
    // not private internals — an `openai` major bump that renamed them would
    // fail here loudly, which is the point.
    const azureClient = client as unknown as { deploymentName?: string; apiVersion?: string };
    expect(azureClient.deploymentName).toBe('gpt-5-policy');
    // The api-version travels as a default query parameter, as Azure requires.
    expect(azureClient.apiVersion).toBeTruthy();
    // And the deployment is what every request asks for by name.
    expect(azure.model({ endpoint: 'x', deployment: ' gpt-5-policy ', apiKey: 'k' })).toBe('gpt-5-policy');
  });

  it('refuses a deployment name it would have to escape', () => {
    /*
     * THE PROTECTION MOVED FROM THE CLIENT TO THE VALIDATION, because the SDK
     * removed the client half. `buildRequest` pastes the name into the path with
     * no encoding at all, so what used to come out as `a%20b%2Fc` now builds a
     * genuinely different URL and 404s from a path nobody typed.
     *
     * Azure's own rule is letters, digits, dash and underscore, so refusing
     * anything else costs no real configuration and turns an undiagnosable 404
     * into a sentence naming the field.
     */
    expect(azure.problem({ endpoint: 'https://r.openai.azure.com', deployment: 'a b/c', apiKey: 'k' }))
      .toMatch(/letters, numbers, dashes and underscores/);
  });

  it('trims a trailing slash off a bridge URL instead of doubling it', () => {
    expect(codex.client({ baseUrl: 'http://127.0.0.1:5207/v1///', model: 'm' }).baseURL)
      .toBe('http://127.0.0.1:5207/v1');
  });

  it('lets a loopback bridge have no key at all', () => {
    // The SDK refuses to construct without one, and making every such user
    // invent a value to get past a validation that is not the endpoint's is a
    // worse answer than sending a placeholder.
    expect(() => codex.client({ baseUrl: 'http://127.0.0.1:5207/v1', model: 'm' })).not.toThrow();
  });
});

describe('what a provider offers', () => {
  it('offers exactly what was configured where there is no catalogue', () => {
    // The id is `codex/`-prefixed and the NAME is not: the prefix decides which
    // deadline the run gets (see the block at the bottom of this file), and the
    // reader should see the model they typed rather than our routing.
    expect(codex.models({ baseUrl: 'x', model: 'gpt-5-codex' })).toEqual([
      { id: 'codex/gpt-5-codex', name: 'gpt-5-codex', note: expect.any(String) },
    ]);
    expect(azure.models({ deployment: 'gpt-5-policy' })[0].id).toBe('gpt-5-policy');
    // Nothing configured is an empty menu, not a menu of things that will 404.
    expect(codex.models({})).toEqual([]);
    expect(azure.models({})).toEqual([]);
  });

  it('offers the whole catalogue for OpenRouter', () => {
    expect(openrouter.models({}).length).toBeGreaterThan(1);
  });
});

describe('what a build offers', () => {
  it('is everything by default', () => {
    delete process.env.POLICY_PROVIDERS;
    expect(providers().map((p) => p.id)).toEqual(['openrouter', 'codex', 'azure', 'databricks']);
  });

  it('narrows to a named list, which is how the Codex bridge leaves a shipped build', () => {
    process.env.POLICY_PROVIDERS = 'openrouter, azure';
    expect(providers().map((p) => p.id)).toEqual(['openrouter', 'azure']);
    expect(providerById('codex')).toBeNull();
  });

  it('ignores a name it does not know rather than refusing to start', () => {
    process.env.POLICY_PROVIDERS = 'openrouter,bedrock';
    expect(providers().map((p) => p.id)).toEqual(['openrouter']);
  });

  it('falls back to everything when the list names nothing real', () => {
    // A typo in a deployment variable must not leave a service that cannot
    // reach a model at all.
    process.env.POLICY_PROVIDERS = 'bedrock,vertex';
    expect(providers().map((p) => p.id)).toEqual(['openrouter', 'codex', 'azure', 'databricks']);
  });
});

describe('what the panel is allowed to see', () => {
  it('reports whether a secret is set and NEVER what it is', () => {
    const out = redact(azure, {
      endpoint: 'https://r.openai.azure.com',
      deployment: 'd',
      apiKey: 'super-secret-value',
      apiVersion: '2024-10-21',
    });
    expect(out.apiKey).toBe(true);
    expect(JSON.stringify(out)).not.toContain('super-secret');
    // Everything that is not a secret comes back as it was, so the panel can
    // show what is configured rather than making the reader retype it.
    expect(out.endpoint).toBe('https://r.openai.azure.com');
    expect(out.apiVersion).toBe('2024-10-21');
  });

  it('says a secret is unset rather than reporting an empty string as a value', () => {
    expect(redact(openrouter, {}).apiKey).toBe(false);
    expect(redact(openrouter, { apiKey: '  ' }).apiKey).toBe(false);
  });
});

/**
 * THE `codex/` PREFIX IS A DEADLINE, NOT A LABEL.
 *
 * `coerceModelContext` reads which provider a run is on from this prefix alone,
 * and `callTimeoutMs` then allows a Codex context 420 seconds a call against
 * OpenRouter's 180. A bridge model registered under its bare name is therefore
 * commissioned as an OpenRouter one and judged against the short deadline — so
 * the one provider that genuinely needs seven minutes would be given three, and
 * every call past three minutes reported as the model being too slow.
 */
describe('a Codex model carries its provider in its id', () => {
  const codex = providerById('codex')!;
  const config = { baseUrl: 'http://127.0.0.1:5207/v1', model: 'gpt-5.6-sol' };

  it('offers the id prefixed, so the run is recognised as Codex', () => {
    expect(codex.models(config)[0].id).toBe('codex/gpt-5.6-sol');
  });

  it('resolves that id back to the codex provider and the long deadline', () => {
    expect(coerceModelContext({ modelId: codex.models(config)[0].id }).provider).toBe('codex');
    // The bare name does not, which is the bug this pair of tests exists for.
    expect(coerceModelContext({ modelId: 'gpt-5.6-sol' }).provider).toBe('openrouter');
  });

  it('sends the BARE slug to the endpoint, which has never heard of the prefix', () => {
    expect(codex.model(config)).toBe('gpt-5.6-sol');
  });

  it('does not double the prefix if the reader typed one', () => {
    expect(codex.models({ ...config, model: 'codex/gpt-5.6-sol' })[0].id).toBe('codex/gpt-5.6-sol');
  });
});

/**
 * A COMMISSION THAT DEGRADES TAKES THE DEADLINE WITH IT.
 *
 * `isOfferedModel` gates what a submission may name, and it consults the ids the
 * ACTIVE provider serves — a set that was only ever filled when somebody opened
 * the admin panel. After a restart it is empty, so a Codex model is read as
 * unknown, `policy_analyses.model` records null, `coerceModelContext` reads the
 * run as OpenRouter, and `callTimeoutMs` allows 180 seconds instead of 420.
 *
 * The call still reaches the bridge either way, which is what makes this quiet:
 * the run is simply judged against a deadline it was never meant to face.
 */
describe('registering what the active provider serves', () => {
  const codex = providerById('codex')!;
  const config = { baseUrl: 'http://127.0.0.1:5207/v1', model: 'gpt-5.6-sol' };

  it('refuses a Codex id while the set is empty', () => {
    registerProviderModels([]);
    expect(isOfferedModel('codex/gpt-5.6-sol')).toBe(false);
  });

  it('accepts it once the provider has been registered', () => {
    registerProviderModels(codex.models(config).map((m) => m.id));
    expect(isOfferedModel('codex/gpt-5.6-sol')).toBe(true);
  });

  it('a refused id is what costs the long deadline', () => {
    // Degrading to null is not neutral: the run stops being a Codex run.
    expect(coerceModelContext({ modelId: 'codex/gpt-5.6-sol' }).provider).toBe('codex');
    // Whatever the default resolves to, it has no `codex/` prefix — that is
    // the whole mechanism, and it is why degrading is not a neutral act.
    expect(coerceModelContext({ modelId: 'anthropic/claude-sonnet-4.5' }).provider).toBe('openrouter');
  });
});

/**
 * THE TRANSPORT MUST NOT BE THE THING THAT DECIDES.
 *
 * Node's fetch is undici, whose headersTimeout and bodyTimeout default to 300
 * seconds. `SLOW_PROVIDER_TIMEOUT_MS` allows a Codex call 420. Without a
 * dispatcher the socket gives up two minutes early and `provider.ts` reports it
 * through the transport branch as "the configured model provider could not be
 * reached" — the bridge blamed for a limit nobody wrote down.
 */
describe('a Codex call can run as long as its deadline allows', () => {
  const codex = providerById('codex')!;
  const client = codex.client({ baseUrl: 'http://127.0.0.1:5207/v1', model: 'gpt-5.6-sol' });

  it('carries a dispatcher, so undici is not the limit', () => {
    expect((client as unknown as { fetchOptions?: { dispatcher?: unknown } }).fetchOptions?.dispatcher)
      .toBeDefined();
  });

  it('uses undici’s own fetch, because a dispatcher from another copy is refused', () => {
    // Node's built-in fetch is a DIFFERENT undici. Passing our dispatcher to it
    // fails instantly with "may be caused by passing an undici dispatcher...
    // that is incompatible" — the pair has to match.
    const used = (client as unknown as { fetch?: unknown }).fetch;
    expect(used).toBeTypeOf('function');
    expect(used).not.toBe(globalThis.fetch);
  });

  it('leaves OpenRouter alone, whose 180s deadline is inside undici’s patience', () => {
    const or = providerById('openrouter')!.client({ apiKey: 'sk-or-test' });
    expect((or as unknown as { fetchOptions?: unknown }).fetchOptions).toBeUndefined();
  });
});

/**
 * A RUN THAT COMMISSIONS NOTHING STILL HAS A DEADLINE, and it has to be the
 * deadline of the provider that will actually answer.
 *
 * "Use the default" is the first option in the picker and the ordinary choice,
 * so `policy_analyses.model` is null for most runs. `provider.ts` then falls
 * back to `resolveResearchDeepModel()`, which used to be a constant OpenRouter
 * id — while `getLLMClient` prefers `definition.model(config)` and sent the call
 * to the bridge regardless. The run was therefore judged against a deadline
 * belonging to a model it never called.
 *
 * Measured on 2026-09-20: four of the first five calls of a real assessment died
 * at exactly 180.0s each, the fifth answered in 173.3s, on a bridge whose own
 * deadline is 420.
 */
describe('the model a run falls back to when it commissioned none', () => {
  const bridge = providerById('codex')!;
  const bridgeConfig = { baseUrl: 'http://127.0.0.1:5207/v1', model: 'gpt-5.6-luna' };
  const direct = providerById('openrouter')!;

  it('names the bridge model, prefixed, so the run is read as Codex', async () => {
    registerProviderPinnedModel(pinnedModel(bridge, bridgeConfig));
    const context = await resolveResearchDeepModel();
    expect(context.modelId).toBe('codex/gpt-5.6-luna');
    expect(context.provider).toBe('codex');
  });

  it('beats POLICY_RESEARCH_MODEL, which could never have reached the model', async () => {
    // Setting it changed nothing but the deadline, and changed that wrongly.
    process.env.POLICY_RESEARCH_MODEL = 'anthropic/claude-sonnet-4.5';
    registerProviderPinnedModel(pinnedModel(bridge, bridgeConfig));
    expect((await resolveResearchDeepModel()).provider).toBe('codex');
  });

  it('leaves a provider that takes the run’s own choice alone', async () => {
    registerProviderPinnedModel(pinnedModel(direct, { apiKey: 'sk-or-test' }));
    delete process.env.POLICY_RESEARCH_MODEL;
    const context = await resolveResearchDeepModel();
    expect(context.provider).toBe('openrouter');
    expect(context.modelId).toBe(DEFAULT_RESEARCH_DEEP_MODEL_ID);
  });

  it('still honours POLICY_RESEARCH_MODEL where nothing is pinned', async () => {
    process.env.POLICY_RESEARCH_MODEL = 'z-ai/glm-5.2';
    expect((await resolveResearchDeepModel()).modelId).toBe('z-ai/glm-5.2');
  });
});

/**
 * WHICH ID THE PIN IS RECORDED UNDER, which is the whole mechanism.
 *
 * `coerceModelContext` recovers the provider from the `codex/` prefix and from
 * nothing else, so a pin recorded under the bare slug the endpoint is sent would
 * be read straight back as OpenRouter — the bug, reintroduced one layer down.
 */
describe('the id a pinned provider model is recognised by', () => {
  it('takes the prefixed id from the menu, not the slug sent to the endpoint', () => {
    const bridge = providerById('codex')!;
    const config = { baseUrl: 'http://127.0.0.1:5207/v1', model: 'gpt-5.6-luna' };
    expect(bridge.model(config)).toBe('gpt-5.6-luna');
    expect(pinnedModel(bridge, config)?.id).toBe('codex/gpt-5.6-luna');
  });

  it('is an Azure deployment’s own name, which is the id it is offered under', () => {
    const foundry = providerById('azure')!;
    const config = { endpoint: 'https://r.openai.azure.com', deployment: 'gpt-5-policy', apiKey: 'k' };
    expect(pinnedModel(foundry, config)?.id).toBe('gpt-5-policy');
  });

  it('is null for OpenRouter, whose menu is a choice rather than a pin', () => {
    expect(pinnedModel(providerById('openrouter')!, { apiKey: 'sk-or-test' })).toBeNull();
  });

  it('is the pinned id when OpenRouter does name one, absent from its menu', () => {
    const or = providerById('openrouter')!;
    expect(pinnedModel(or, { apiKey: 'sk-or-test', model: 'deepseek/deepseek-v4-flash' })?.id)
      .toBe('deepseek/deepseek-v4-flash');
  });
});

/**
 * A MENU THAT OFFERS WHAT CANNOT BE CALLED IS THE SAME BUG, ONE ROAD OVER.
 *
 * With the bridge active, the submit page still drew the panel's five OpenRouter
 * ids. Picking one passed `isOfferedModel`, was recorded in
 * `policy_analyses.model`, read back as an OpenRouter run — the 180-second
 * deadline again — and was then not the model called, because `getLLMClient`
 * prefers the provider's own. Three wrong things from one dropdown.
 */
describe('what a submission may commission while a provider pins its model', () => {
  const bridge = providerById('codex')!;
  const bridgeConfig = { baseUrl: 'http://127.0.0.1:5207/v1', model: 'gpt-5.6-luna' };

  it('offers the pinned model and nothing else', () => {
    registerProviderPinnedModel(pinnedModel(bridge, bridgeConfig));
    expect(commissionableModels().map((m) => m.id)).toEqual(['codex/gpt-5.6-luna']);
  });

  it('names it as the endpoint does, not as the routing prefix does', () => {
    registerProviderPinnedModel(pinnedModel(bridge, bridgeConfig));
    expect(commissionableModels()[0].name).toBe('gpt-5.6-luna');
  });

  it('refuses a menu id that would be accepted, recorded, and then not called', () => {
    registerProviderModels(bridge.models(bridgeConfig).map((m) => m.id));
    registerProviderPinnedModel(pinnedModel(bridge, bridgeConfig));
    expect(isOfferedModel('codex/gpt-5.6-luna')).toBe(true);
    expect(isOfferedModel('z-ai/glm-5.2')).toBe(false);
    // And refusing lands on the pin anyway, by the other road.
    expect(coerceModelContext({ modelId: 'z-ai/glm-5.2' }).provider).toBe('openrouter');
  });

  it('is the panel’s own menu again once nothing is pinned', () => {
    registerProviderPinnedModel(null);
    expect(commissionableModels().length).toBeGreaterThan(1);
    expect(isOfferedModel('z-ai/glm-5.2')).toBe(true);
  });
});
