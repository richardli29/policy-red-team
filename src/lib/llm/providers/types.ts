/**
 * WHERE A MODEL CALL GOES, AND ON WHOSE BILL.
 *
 * `getLLMClient` used to hard-code one OpenRouter key read from the environment,
 * which is right for a tool with one user and a `.env` and wrong the moment
 * somebody wants to point it at a subscription they already pay for. This is the
 * registry that replaces it: one module per service, each owning its own fields,
 * its own client and its own account of what it costs.
 *
 * IT DOES NOT TOUCH `ModelProvider`. That union — `'openrouter' | 'codex'` — is
 * in a COPIED file and belongs to the pipeline's own `ModelContext`, which
 * records what an assessment was run on. Extending it would be a divergence on a
 * file the fork keeps byte-identical, for no gain: the pipeline never chooses a
 * service, it asks for a model and the registry decides who serves it. The two
 * vocabularies stay separate on purpose.
 *
 * REMOVING A PROVIDER IS DELETING A FILE. Each is self-contained and the registry
 * is a list; `POLICY_PROVIDERS` narrows that list without a rebuild. A build that
 * ships to other people drops `codex` — which is a local bridge against one
 * person's subscription and no use to anyone else — by naming the two that stay.
 */
import type OpenAI from 'openai';

export type ProviderId = 'openrouter' | 'codex' | 'azure' | 'databricks';

/** One thing a reader has to supply. `secret` never comes back out of the server. */
export type ProviderField = {
  name: string;
  label: string;
  hint: string;
  /** Written once, never read back. The panel shows whether it is set, not what it is. */
  secret?: boolean;
  /** Shown in the field when nothing is stored, and used when the reader leaves it blank. */
  placeholder?: string;
  optional?: boolean;
  /**
   * HOW THE READER ANSWERS, not just where the answer is kept.
   *
   * Text is the default and was the only option. `select` exists because Azure
   * has four ways to authenticate and they take different fields: a flat list of
   * every field all four might need is eleven boxes, of which a reader fills in
   * three and has to work out which three. A question with four answers is one
   * box, and `showWhen` below reveals only what that answer needs.
   */
  kind?: 'text' | 'select';
  /** For `kind: 'select'`. The FIRST is the default when nothing is stored. */
  options?: { value: string; text: string }[];
  /**
   * Show this field only when another field holds one of these values.
   *
   * A hint, not a guarantee: the panel hides the field and the server still
   * stores whatever is sent. `problem()` is the thing that decides what a
   * configuration needs — a hidden field that is nonetheless required would be
   * a configuration nobody could complete, and the sentence `problem()` returns
   * is what the reader would have to act on.
   */
  showWhen?: { field: string; is: string[] };
};

/** What a reader has configured for one provider, as stored. */
export type ProviderConfig = Record<string, string>;

export type ProviderDefinition = {
  id: ProviderId;
  label: string;
  /** What this is, in the reader's terms — shown above the fields. */
  blurb: string;
  fields: ProviderField[];
  /**
   * EVERY HOST THIS PROVIDER NEEDS TO REACH, in a reader's words.
   *
   * A network team in a restricted estate asks for one thing — the list — and
   * the answer used to be assembled by hand from whoever remembered. That is
   * how `login.microsoftonline.com` gets left off a firewall change and the
   * failure arrives a week later as "Entra does not work".
   *
   * These are printed by `npm run doctor`, by the setup wizard's egress step
   * and by the README, from this one declaration. An entry may be a description
   * rather than a hostname where the host is the reader's own — nobody can
   * write down an Azure resource endpoint on their behalf.
   */
  egress: string[];
  /**
   * The longest ONE CALL to this provider may take, in milliseconds.
   *
   * The pipeline's own table (`provider.ts`, copied) can name only `openrouter`
   * and `codex`, so everything else was judged against OpenRouter's 180 seconds
   * — including an Azure deployment, which is provisioned, often slower, and
   * measured on this estate at 237s and over 301s at stage one. Every call over
   * three minutes was reported as the model being too slow, which was true of
   * the deadline and not of the model.
   *
   * Optional: absent means the pipeline's own rule decides, which is right for
   * the two providers it knows by name. See `$lib/server/models/call-deadline`
   * for how it reaches a copied file.
   */
  callTimeoutMs?: number;
  /**
   * Whether this configuration is complete enough to try.
   *
   * Returns a sentence when it is not, so the panel can say which field is
   * missing rather than failing on the first call.
   */
  problem(config: ProviderConfig): string | null;
  /** The model id calls are made with. For a deployment-based service this IS the deployment. */
  model(config: ProviderConfig): string;
  /** Built fresh per call site; the caller caches. */
  client(config: ProviderConfig): OpenAI;
  /**
   * What this provider can serve, for the model picker.
   *
   * OpenRouter has a catalogue; a bridge or a deployment has exactly what the
   * reader configured, and saying so beats offering a menu of things that will
   * 404.
   */
  models(config: ProviderConfig): { id: string; name: string; note: string }[];
  /**
   * EVERYTHING THE SERVICE WILL SELL YOU, asked at the moment it is asked.
   *
   * `models()` above is the curated menu an assessment picks from — five things
   * with an opinion attached. This is the raw list behind it, for the admin
   * panel to choose that menu FROM, and the two must not be confused: one is a
   * decision, the other is inventory.
   *
   * Optional, because not every service has one to give. OpenRouter and any
   * OpenAI-compatible bridge answer `GET /v1/models`; an Azure deployment does
   * not — its list lives behind a separate ARM API against a different
   * credential, and inventing one from the deployment name would be a menu of
   * one thing the reader already typed.
   *
   * It costs a network call and it can fail. The caller is the admin panel,
   * which is allowed to be slow and is the right place to show the error.
   */
  catalogue?(config: ProviderConfig): Promise<CatalogueEntry[]>;
  /**
   * A CLIENT THAT CAN SEARCH THE WEB, where this provider offers one.
   *
   * The research stage needs sources, and without a Tavily key it plans its
   * questions and answers none of them — twelve "research unavailable" warnings
   * and an evidence matrix with nothing external in it.
   *
   * The Codex bridge has served `/v1/grounded/chat/completions` all along: the
   * same call with web search switched on, against a subscription already being
   * paid for. This is how a provider says so.
   *
   * Optional, and absent is a real answer. Azure has no web search at all, and a
   * provider that pretends to search and answers from memory would put invented
   * sources in an assessment — far worse than an acknowledged gap.
   */
  grounded?(config: ProviderConfig): { client: OpenAI; model: string } | null;
};

/**
 * One row of a provider's live inventory.
 *
 * `promptCost`/`completionCost` are USD PER MILLION TOKENS, converted from
 * whatever the provider quotes, because per-token prices are eight leading
 * zeroes and nobody can compare those at a glance. Null where the service does
 * not say — a bridge billing against a subscription has no per-token price and
 * should not be made to invent one.
 */
export type CatalogueEntry = {
  id: string;
  name: string;
  description: string;
  contextLength: number | null;
  promptCost: number | null;
  completionCost: number | null;
  /** True for an id that redirects to whatever is newest in a family. */
  floating: boolean;
};
