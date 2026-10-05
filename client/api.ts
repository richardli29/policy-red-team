/**
 * Talking to the server.
 *
 * Thin on purpose. The shapes come from the copied store — `detail()` returns
 * what `detail()` returns — so the types here describe that rather than
 * redefining it, and a change upstream shows up as a type error instead of an
 * empty panel.
 */
import type { Artefact } from '$lib/policy-analysis/contracts';
import type { PassRow, RunCost } from '$lib/policy-analysis/view';

export interface OfferedModel {
  id: string;
  name: string;
  note: string;
  tier: 'economy' | 'balanced' | 'frontier';
}

export interface AnalysisRow {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  /**
   * When it last moved. With `createdAt` it is how long the run went on for,
   * which is the one field that discriminates on the landing page: sixteen rows
   * of the same paper started on the same morning are otherwise identical but for
   * a status tag, and the 2h21m assessment holding 2,265 artefacts looks exactly
   * like a stub that lived for ninety seconds.
   */
  updatedAt: string;
  completedAt: string | null;
  jurisdiction: string | null;
  policyArea: string | null;
}

export interface StageRow {
  ordinal: number;
  name: string;
  status: string;
  warnings: string[];
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  /**
   * How many artefacts this stage minted.
   *
   * Counted from `artefactMetadata` in `forTheReport` rather than in the
   * browser, because the offline pack carries no metadata at all — so a count
   * derived in the component would be a figure the service had and the pack
   * could not, and the two copies of one assessment would disagree about what a
   * stage produced. Optional because a read that is not `?view=report` does not
   * carry it.
   */
  kept?: number;
}

export interface Detail {
  analysis: AnalysisRow & { model: string | null; thinkingLevel: string | null; depth: string; sealed: boolean; error: string | null; context: string | null };
  stages: StageRow[];
  artefacts: Artefact[];
  /**
   * The stage and timestamp of every artefact, read off the row rather than
   * inferred from its id. `detail()` has always sent this; nothing described it
   * until the drill needed to say when a thing was produced, and an id-derived
   * stage was quietly wrong for everything the pipeline computes rather than
   * writes — see src/lib/provenance.ts.
   */
  artefactMetadata: { id: string; stage: number; updatedAt: string }[];
  /**
   * Material attached after the report was written, and restatements over it.
   *
   * Typed against the copied view layer's own row shape rather than redescribed
   * here, so `addenda()` and `addendumBanner()` take it unchanged.
   */
  passes: PassRow[];
  personas: { actorId: string | null; personaId: string; name: string; sightings: number }[];
  heartbeat: string | null;
  /**
   * How many of each kind the assessment holds, when the answer was capped.
   *
   * `?view=progress` sends the first 25 artefacts of each kind — which is all the
   * run index shows — so the lengths of `artefacts` are no longer the totals. The
   * counts come separately rather than being inferred, because "Assumptions — 25"
   * beside a list of 25 is a quieter kind of wrong than a slow page.
   */
  artefactCounts?: Record<string, number>;
  /**
   * The models the run was actually made of, busiest first.
   *
   * Separate from `analysis.model`, which is what was COMMISSIONED. They are the
   * same thing until a run is resumed after the configured default has moved, at
   * which point one assessment has been made by two models and the provenance
   * section has to say so.
   */
  models?: { id: string; calls: number }[];
  /**
   * What the run spent: tokens in and out, what was served from cache, what it
   * cost in cash where anything reported a price.
   *
   * `runCost()` has computed this in the copied view layer all along and had
   * zero call sites; the figure was drawn once, by `RunClock`, while the run was
   * in flight, and unmounted with it. `null` means nothing reported usage — not
   * a run that spent nothing, which is the distinction `runCost`'s own comment
   * was written to protect.
   */
  cost?: RunCost | null;
  /** True when the server refuses every mutation, so the page can decline to draw a control that would 403. */
  readOnly: boolean;
}

/** A trait the library holds about a body, folded across every paper that said it. */
export interface PersonaTrait {
  key: string;
  label: string;
  value: string;
  origin: string;
  confidence: number | null;
}

/** A row in the library. `listPersonas` computes far more than the list used to show. */
export interface PersonaSummary {
  id: string;
  name: string;
  entityType: string;
  aliases: string[];
  summary: string | null;
  dossier: PersonaTrait[];
  sightings: number;
  researchedAt: string | null;
  updatedAt: string | null;
  lastSeen: string | null;
  worstBand: string | null;
  plays: number;
  researchNotes: number;
}

/** One assessment's or one research pass's contribution to a persona. */
export interface PersonaObservation {
  id: string;
  personaId: string;
  kind: 'assessment' | 'research';
  analysisId: string | null;
  analysisTitle: string | null;
  actorId: string | null;
  traits: PersonaTrait[];
  plays: { label: string; band: string; exposure: number; legality: string }[];
  sources: { url: string; title: string; quality: string }[];
  note: string | null;
  observedAt: string | null;
}

export interface PersonaDossier {
  persona: PersonaSummary;
  observations: PersonaObservation[];
  analyses: { id: string; title: string; status: string; completedAt: string | null; policyArea: string | null }[];
  readOnly: boolean;
}

/** One field a provider needs. A `secret` is written once and never read back. */
/**
 * Mirrors `ProviderField` in `$lib/llm/providers/types`, which is the server's
 * own and the one that decides. Kept as a separate declaration because the
 * client bundle must not import server code, and kept in step by
 * `field-shape.test.ts` — the panel rendering a field kind the server can emit,
 * or failing to, is a form a reader cannot complete.
 */
export interface ProviderField {
  name: string;
  label: string;
  hint: string;
  secret?: boolean;
  placeholder?: string;
  optional?: boolean;
  /** `select` renders a dropdown; anything else is a text box. */
  kind?: 'text' | 'select';
  /** For `kind: 'select'`. The first is the default when nothing is stored. */
  options?: { value: string; text: string }[];
  /** Render this field only when another field holds one of these values. */
  showWhen?: { field: string; is: string[] };
}

export interface ProviderView {
  id: string;
  label: string;
  blurb: string;
  fields: ProviderField[];
  /** A secret arrives as `true`/`false` — set or not — and never as its value. */
  values: Record<string, string | boolean>;
  models: { id: string; name: string; note: string }[];
}

/** One row of a provider's live inventory. Costs are USD per MILLION tokens. */
export interface CatalogueEntry {
  id: string;
  name: string;
  description: string;
  contextLength: number | null;
  promptCost: number | null;
  completionCost: number | null;
  /** An id that redirects to whatever is newest in its family. */
  floating: boolean;
}

/** The setup wizard's task list. Derived by the server from what the install holds. */
export interface SetupState {
  tasks: { id: string; title: string; href: string; status: 'done' | 'todo' | 'optional'; detail: string }[];
  /** True only when a provider has actually ANSWERED — configured is not reachable. */
  ready: boolean;
  provider: string;
  egress: string[];
}

export interface AdminConfig {
  active: string;
  activeProblem: string | null;
  /** Fields the environment supplies, which the panel cannot override. */
  fromEnvironment: string[];
  /** True when POLICY_PROVIDER pins the choice for this deployment. */
  pinned: boolean;
  providers: ProviderView[];
  /** What the assessment picker offers today. */
  menu: OfferedModel[];
  /** True when somebody chose that menu, rather than it being this build's default. */
  menuChosen: boolean;
  /** True when POLICY_MODELS pins it, in which case the panel cannot change it. */
  menuPinned: boolean;
  /** Who may read the assessments. Separate credential from this page's. */
  access: 'open' | 'password';
  accessPinned: boolean;
  accessSummary: string;
  /** True when POLICY_ADMIN_PASSWORD decides it, so this page cannot. */
  adminPasswordPinned: boolean;
  /** Every host this install needs to reach, for a firewall change. */
  egress: string[];
  /** Where research looks, and the sentence a reader is told about it. */
  search: {
    engine: 'auto' | 'tavily' | 'grounded' | 'none';
    pinned: boolean;
    tavilyKeySet: boolean;
    domains: string;
    /** What will actually happen, which is not always what was chosen. */
    kind: 'tavily' | 'grounded' | 'none';
    why: string;
  };
  /** What a reset would restore. */
  builtIn: OfferedModel[];
  /** Whether the active provider will list what it sells. Azure will not. */
  canBrowse: boolean;
  /** The most one run may spend, in tokens. 0 means no ceiling. */
  tokenCeiling: number;
}

/** How far a run has got, and when it should be done. Polled while it runs. */
export interface RunProgress {
  status: string;
  stagesDone: number;
  stagesTotal: number;
  currentStage: string | null;
  calls: { completed: number; failed: number; running: number };
  estimate: {
    calls: { low: number; high: number };
    made: number;
    seconds: { low: number; high: number } | null;
    perCall: number | null;
    measured: number;
    basis: string;
  } | null;
  /** Measured consumption, and where it is heading. Null until usage is reported. */
  tokens: {
    input: number;
    cached: number;
    output: number;
    reasoning: number;
    total: number;
    cachedShare: number | null;
    projectedTotal: number | null;
  } | null;
  /** Only when a weekly allowance is configured — Codex publishes no quota to read. */
  allowance: { weeklyTokens: number; usedByThisRun: number; projectedShare: number | null } | null;
  says: string;
  /** ISO instants, computed on the SERVER so a skewed client clock cannot lie. */
  finishBy: { earliest: string; latest: string } | null;
}

export interface Landing {
  analyses: AnalysisRow[];
  models: OfferedModel[];
  stages: readonly string[];
  /** True when the server refuses every mutation. See src/lib/server/read-only.ts. */
  readOnly: boolean;
}

class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }));
    throw new ApiError((body as { message?: string }).message ?? 'That did not work.');
  }
  return (await response.json()) as T;
}

/**
 * ONE FETCH OF ONE ASSESSMENT, HELD WHILE THE READER MOVES AROUND IT.
 *
 * `Assessment` and `Drill` are sibling routes, so following a play out of the
 * report unmounts one and mounts the other, and pressing Back unmounts and
 * mounts again. Each remount called `detail` and each call was the whole
 * assessment: measured on the live service, report → drill → Back is three
 * fetches and 13,469,643 decoded bytes to look at one play and come back.
 *
 * The comment on the drill's own fetch defends it on the grounds that the drill
 * needs the whole list anyway. That is true of the DATA and says nothing about
 * the REQUEST.
 *
 * KEYED BY VIEW as well as by id, because `?view=report` is a different and
 * smaller answer, and handing the report's stubbed artefacts to the drill would
 * give it blank pages for the five kinds it is the only thing that renders.
 *
 * THE PROMISE IS CACHED, NOT THE RESULT, so two components mounting in the same
 * tick share one request instead of racing two. A rejected one is dropped
 * immediately: a failure must not be remembered as an answer.
 */
export type DetailView = 'report' | 'progress';

const held = new Map<string, Promise<Detail>>();

/** Anything that changes an assessment drops it. See `api.act`, `material`, `purge`. */
export function forget(id?: string): void {
  if (!id) { held.clear(); return; }
  for (const key of [...held.keys()]) if (key.startsWith(`${id}|`)) held.delete(key);
}

function heldDetail(id: string, view?: DetailView): Promise<Detail> {
  const key = `${id}|${view ?? 'full'}`;
  const found = held.get(key);
  if (found) return found;
  const query = view ? `?view=${view}` : '';
  const pending = request<Detail>(`/api/policy-analysis/${id}${query}`);
  held.set(key, pending);
  void pending.catch(() => held.delete(key));
  return pending;
}

export const api = {
  landing: () => request<Landing>('/api/policy-analysis'),
  /**
   * Everything, including the kinds only the drill renders.
   *
   * `view` narrows it to what the report draws — see `forTheReport` in
   * `server/api.ts`. On the real run that is 4.5 MB against about 3.1 MB.
   */
  detail: (id: string, view?: DetailView) => heldDetail(id, view),
  /** Drop what is held for an assessment, so the next read goes to the server. */
  forget,
  submit: (form: FormData) => request<{ id: string }>('/api/policy-analysis', { method: 'POST', body: form }),
  /** Attach something read AFTER the report was written. Starts a four-stage pass; spends. */
  material: (id: string, form: FormData) => {
    forget(id);
    return request<{ status: string }>(`/api/policy-analysis/${id}/material`, { method: 'POST', body: form });
  },
  /** Small enough to poll: a dozen numbers, not every artefact of the run. */
  progress: (id: string) => request<RunProgress>(`/api/policy-analysis/${id}/progress`),
  act: (id: string, action: 'cancel' | 'resume' | 'restate') => {
    forget(id);
    return request<{ status: string }>(`/api/policy-analysis/${id}/${action}`, { method: 'POST' });
  },
  purge: (id: string) => {
    forget(id);
    return request<{ receipt: unknown }>(`/api/policy-analysis/${id}`, { method: 'DELETE' });
  },
  personas: () => request<{ personas: PersonaSummary[]; readOnly: boolean }>('/api/policy-analysis/personas'),
  persona: (id: string) => request<PersonaDossier>(`/api/policy-analysis/personas/${id}`),
  forgetPersona: (id: string) => request<{ removed: boolean }>(`/api/policy-analysis/personas/${id}`, { method: 'DELETE' }),
  /** Spends: two model calls plus retrieval. Refused outright in a read-only copy. */
  researchPersona: (id: string) =>
    request<{ sources: number; traits: number }>(`/api/policy-analysis/personas/${id}/research`, { method: 'POST' }),
};

/**
 * The admin panel, which is the only part of this service behind a password.
 *
 * A secret goes in and never comes back: `config()` reports whether each one is
 * set, not what it is.
 */
export const admin = {
  status: () =>
    request<{
      available: boolean;
      problem: string | null;
      signedIn: boolean;
      /** True when this install has never been set up and may be claimed now. */
      claimable: boolean;
      /** True when claiming it also needs POLICY_SETUP_TOKEN, because it is not on loopback. */
      tokenRequired: boolean;
      /** Set on Databricks Apps when a workspace group, not a password, decides who is an admin. */
      group?: string;
    }>('/api/admin/status'),
  /**
   * Set this install's first admin password, using the credential it ships with.
   *
   * There is no session until this succeeds: a cookie issued under a password
   * printed in the README would be a session token minted under a guessable
   * credential.
   */
  claim: (fields: { username: string; password: string; newPassword: string; setupToken?: string }) =>
    request<{ signedIn: boolean }>('/api/admin/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  /** Change the admin password. Every other session ends the moment this returns. */
  changePassword: (current: string, next: string) =>
    request<{ changed: boolean }>('/api/admin/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current, next }),
    }),
  /** Where research looks for sources. */
  setSearch: (fields: { engine?: string; tavilyKey?: string; domains?: string }) =>
    request<AdminConfig>('/api/admin/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  /** Who may read the assessments, as opposed to who may configure them. */
  setAccess: (mode: 'open' | 'password', readerPassword?: string) =>
    request<AdminConfig>('/api/admin/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, readerPassword }),
    }),
  signIn: (password: string) =>
    request<{ signedIn: boolean }>('/api/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
  signOut: () => request<{ signedIn: boolean }>('/api/admin/session', { method: 'DELETE' }),
  config: () => request<AdminConfig>('/api/admin/config'),
  save: (provider: string, values: Record<string, string>) =>
    request<AdminConfig>(`/api/admin/config/${provider}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
  use: (provider: string) =>
    request<AdminConfig>('/api/admin/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    }),
  /** What is left to set up, as a task list. Statuses are the server's, not the page's. */
  setup: () => request<SetupState>('/api/admin/setup'),
  /** Everything the active provider sells. A few hundred rows and a network call. */
  catalogue: () => request<{ provider: string; entries: CatalogueEntry[] }>('/api/admin/catalogue'),
  /** The most one run may spend, in tokens. 0 clears the ceiling. */
  setCeiling: (tokens: number) =>
    request<AdminConfig>('/api/admin/ceiling', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens }),
    }),
  /** Set the assessment picker's menu. An empty list resets to the built-in one. */
  saveModels: (models: { id: string; name: string; note: string; cost: number | null }[]) =>
    request<AdminConfig>('/api/admin/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models }),
    }),
  /** One token of output against the live configuration. "Saved" is not "reachable". */
  test: () => request<{ ok: boolean; provider: string; model?: string; ms: number; message?: string }>(
    '/api/admin/test',
    { method: 'POST' },
  ),
};

/**
 * Watch a run.
 *
 * Server-sent events, not polling: a run emits a handful of updates over several
 * minutes, and asking every second for twenty of them is the wrong shape of work.
 * `EventSource` reconnects on its own, which is most of why it is worth using
 * over a socket for something this one-directional.
 */
export function watchRun(id: string, handlers: { stage?: () => void; done?: () => void; error?: (message: string) => void }): () => void {
  const source = new EventSource(`/api/policy-analysis/${id}/events`);
  source.addEventListener('stage', () => handlers.stage?.());
  source.addEventListener('done', () => {
    handlers.done?.();
    source.close();
  });
  source.addEventListener('error', (event) => {
    // An EventSource error is usually a reconnect, not a failure — only our own
    // "error" event carries a message worth showing.
    const data = (event as MessageEvent).data;
    if (typeof data === 'string' && data) {
      try { handlers.error?.((JSON.parse(data) as { message: string }).message); } catch { /* reconnect */ }
    }
  });
  return () => source.close();
}
