/**
 * THE REGISTRY, AND WHAT A BUILD OFFERS.
 *
 * Every provider is a self-contained module. Adding one is a file and a line
 * here; removing one is deleting both, and nothing else in the service knows the
 * difference — the pipeline asks for a model, the registry decides who serves
 * it, and no copied file mentions any of this.
 *
 * `POLICY_PROVIDERS` narrows the list without a rebuild, which is how a build
 * meant for other people drops the Codex bridge: it runs against one person's
 * subscription on one machine and is no use to anybody else. Set it to
 * `openrouter,azure` and the entry stops being offered, stops being configurable
 * and stops being selectable — including for an install that had already chosen
 * it, which then says so rather than silently calling something else.
 */
import type { ProviderDefinition, ProviderId } from './types';
import { openrouter } from './openrouter';
import { codex } from './codex';
import { azure } from './azure';
import { databricks } from './databricks';

export type { ProviderDefinition, ProviderId, ProviderField, ProviderConfig } from './types';

/** Every provider this build knows how to be. Order is the order the panel lists them. */
const ALL: ProviderDefinition[] = [openrouter, codex, azure, databricks];

/**
 * WHETHER A CREDENTIAL IN THIS BUILD COULD EVER REACH ANYTHING. True here,
 * false in `index.fixture.ts`, and it exists for one caller.
 *
 * `modelAccessProblem()` refuses to start an assessment when the active
 * provider is not configured — right for a real build, where the alternative is
 * eighteen stages that exist only to fail. In a FIXTURE build it is nonsense:
 * the model is `provider.fixture.ts`, no credential is read, and `client()`
 * throws by design. Reporting "fill in OpenRouter" there is advice that would
 * not help if taken.
 *
 * It broke `npm run assess:fixture` — the command the README offers as "try it
 * without a key or a bill" — from phase 13 until 2026-09-21. It was invisible
 * because `cli.ts` had also forgotten to await the promise, so the failure read
 * `Promise { <pending> }` and looked like a different bug entirely.
 */
export const REACHES_REAL_PROVIDERS = true;

/**
 * The ones this install offers.
 *
 * An unknown name in `POLICY_PROVIDERS` is IGNORED rather than fatal, and an
 * empty result falls back to everything: a typo in a deployment variable should
 * not leave a service that cannot reach a model at all, and the panel shows
 * which are offered so a missing one is visible rather than mysterious.
 */
export function providers(): ProviderDefinition[] {
  const allowed = process.env.POLICY_PROVIDERS?.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!allowed?.length) return ALL;
  const narrowed = ALL.filter((p) => allowed.includes(p.id));
  return narrowed.length ? narrowed : ALL;
}

export function providerById(id: string | null | undefined): ProviderDefinition | null {
  return providers().find((p) => p.id === id) ?? null;
}

export function isProviderId(id: string | null | undefined): id is ProviderId {
  return !!providerById(id);
}

/**
 * What the panel may show about a provider's configuration.
 *
 * A SECRET NEVER COMES BACK. The panel shows whether one is set and nothing
 * else, which is the same posture the share token had and for the same reason:
 * a value the server will happily read back out is a value that leaks through
 * every log, screenshot and browser cache between here and the reader.
 */
export function redact(definition: ProviderDefinition, config: Record<string, string>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const field of definition.fields) {
    const value = config[field.name] ?? '';
    out[field.name] = field.secret ? Boolean(value.trim()) : value;
  }
  return out;
}
