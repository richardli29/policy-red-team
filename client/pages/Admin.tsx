import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { admin, type AdminConfig, type ProviderView } from '../api';
import { ModelMenu } from './ModelMenu';
import { Button, ButtonGroup, Details, ErrorSummary, InsetText, Input, Radios, Select, SummaryList, Tag, WarningText } from '../govuk';
import { usePageTitle } from '../layout/Template';
import { MEASURED_SCALE } from '../measured';

/**
 * WHERE THIS INSTALL IS CONFIGURED, AND THE ONLY PAGE BEHIND A PASSWORD.
 *
 * Everything else here is as open as the deployment is. This holds credentials,
 * so it is gated — by a signed cookie, never by an address check: behind a
 * tunnel every request arrives from 127.0.0.1, so "local connections only"
 * passes for the whole internet.
 *
 * A SECRET IS WRITE-ONLY. The server reports whether each one is set and never
 * what it is, so this page cannot show a key back even to the person who typed
 * it. That is deliberate and it is worth saying on the page: a reader who
 * expects to check a pasted key against the original needs to know they cannot,
 * before they close the tab.
 *
 * THE ENVIRONMENT WINS. A value in `app.env` overrides anything saved here, and
 * the field says so rather than accepting an edit that will not take effect —
 * the worst version of this page is one that lets you change something and then
 * quietly does not.
 */
export function Admin() {
  usePageTitle('Configuration');
  const [status, setStatus] = useState<Awaited<ReturnType<typeof admin.status>> | null>(null);
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState('');
  /*
   * Bumped on every successful save, and used as the form's React key.
   *
   * An uncontrolled input keeps whatever the reader typed: changing
   * `defaultValue` on a re-render does not clear it. So after saving, the key
   * they had just pasted was still sitting in the box under a hint promising it
   * is never shown again. Remounting the form is the only thing that actually
   * empties it, and it restores the stored values for every field that is not a
   * secret at the same time.
   */
  const [saved, setSaved] = useState(0);

  const load = useCallback(async () => {
    try {
      const next = await admin.status();
      setStatus(next);
      setConfig(next.signedIn ? await admin.config() : null);
    } catch (err) {
      setErrors([(err as Error).message]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setErrors([]);
    try {
      await admin.signIn(password);
      setPassword('');
      await load();
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  async function run<T>(work: () => Promise<T>, then?: (result: T) => void) {
    setBusy(true);
    setErrors([]);
    try {
      then?.(await work());
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <p className="govuk-body" aria-live="polite">Loading…</p>;

  if (!status.available) {
    return (
      <div className="govuk-grid-row">
        <div className="govuk-grid-column-two-thirds">
          <h1 className="govuk-heading-xl">Configuration</h1>
          {/* NO PASSWORD MEANS NO PANEL — not an open one. A service that
              published its credential editor because a deployment variable was
              forgotten is the failure this whole page is gated against. */}
          <InsetText>{status.problem}</InsetText>
          <p className="govuk-body">
            {status.group
              ? 'Ask whoever manages that group to add you if you need to change these settings.'
              : 'Until then this install uses whatever its environment supplies, which is how it has always worked.'}
          </p>
        </div>
      </div>
    );
  }

  /*
   * SETTING THE FIRST PASSWORD, on an install that has never had one.
   *
   * The service ships accepting `admin` / `admin`, and the ONLY thing that
   * credential can do is this form: there is no session until a real password
   * has been written. On anything not bound to loopback it also needs the setup
   * token the operator put in the environment, so a service reachable from
   * outside cannot be claimed by whoever finds it first.
   */
  if (status.claimable) {
    return (
      <div className="govuk-grid-row">
        <div className="govuk-grid-column-two-thirds">
          <span className="govuk-caption-l">Set up</span>
          <h1 className="govuk-heading-l">Choose an admin password</h1>
          {errors.length ? <ErrorSummary errors={errors.map((text) => ({ text, href: '#claim-new' }))} /> : null}
          <p className="govuk-body">
            This install has not been set up yet. It accepts the sign-in it ships with —
            <strong> admin</strong> and <strong> admin</strong> — once, to replace it. Nothing else
            works until you do, and this page is where the model credentials will live.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void run(
                () =>
                  admin.claim({
                    username: String(form.get('username') ?? ''),
                    password: String(form.get('password') ?? ''),
                    newPassword: String(form.get('newPassword') ?? ''),
                    setupToken: String(form.get('setupToken') ?? '') || undefined,
                  }),
                () => void load(),
              );
            }}
            noValidate
          >
            <Input id="claim-username" name="username" label="Sign in as" labelSize="s"
                   hint="The name this service ships with." defaultValue="admin" autoComplete="off" disabled={busy} />
            <Input id="claim-password" name="password" type="password" label="Current password" labelSize="s"
                   hint="The one it ships with." autoComplete="off" disabled={busy} />
            {status.tokenRequired ? (
              <Input id="claim-token" name="setupToken" type="password" label="Setup token" labelSize="s"
                     hint="This service is not on loopback, so it will not accept the shipped sign-in on its own. POLICY_SETUP_TOKEN on the server."
                     autoComplete="off" disabled={busy} />
            ) : null}
            <Input id="claim-new" name="newPassword" type="password" label="New admin password" labelSize="s"
                   hint="At least twelve characters. Length is what makes it hard to guess — a long phrase you can remember beats a short one you cannot."
                   autoComplete="new-password" disabled={busy} />
            <ButtonGroup>
              <Button type="submit" disabled={busy}>{busy ? 'Setting…' : 'Set the password'}</Button>
            </ButtonGroup>
          </form>
        </div>
      </div>
    );
  }

  if (!status.signedIn) {
    return (
      <div className="govuk-grid-row">
        <div className="govuk-grid-column-two-thirds">
          <h1 className="govuk-heading-xl">Configuration</h1>
          {errors.length ? <ErrorSummary errors={errors.map((text) => ({ text, href: '#admin-password' }))} /> : null}
          <p className="govuk-body">
            This page holds the credentials this service makes model calls with. Everything else
            here is open; this is not.
          </p>
          <form onSubmit={(e) => void signIn(e)} noValidate>
            <Input
              id="admin-password"
              name="password"
              type="password"
              label="Admin password"
              labelSize="s"
              hint="Set on the server as POLICY_ADMIN_PASSWORD."
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              disabled={busy}
            />
            <ButtonGroup>
              <Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Sign in'}</Button>
            </ButtonGroup>
          </form>
        </div>
      </div>
    );
  }

  if (!config) return <p className="govuk-body" aria-live="polite">Loading…</p>;

  const active = config.providers.find((p) => p.id === config.active);

  return (
    <>
      <div className="govuk-grid-row">
        <div className="govuk-grid-column-two-thirds">
          <span className="govuk-caption-l">Admin</span>
          <h1 className="govuk-heading-l">Configuration</h1>
          {errors.length ? <ErrorSummary errors={errors.map((text) => ({ text, href: '#admin-active' }))} /> : null}

          <SummaryList
            rows={[
              {
                key: 'Answering calls',
                value: (
                  <>
                    {active?.label ?? config.active}{' '}
                    {config.activeProblem
                      ? <Tag colour="red">Not usable</Tag>
                      : <Tag colour="green">Ready</Tag>}
                    {config.activeProblem ? <><br /><span className="prt-meta">{config.activeProblem}</span></> : null}
                  </>
                ),
              },
              {
                key: 'Chosen by',
                value: config.pinned
                  ? 'POLICY_PROVIDER on the server. This page cannot change it.'
                  : 'This page.',
              },
            ]}
          />

          <p className="govuk-body" role="status">{outcome}</p>
          <ButtonGroup>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(() => admin.test(), (result) =>
                  setOutcome(
                    result.ok
                      ? `${result.provider} answered as ${result.model} in ${result.ms} ms.`
                      : `${result.provider} did not answer: ${result.message}`,
                  ))
              }
            >
              {busy ? 'Trying…' : 'Test the connection'}
            </Button>
            {/* A group admin is signed in by the workspace; there is no session here to end. */}
            {status.group ? null : (
              <Button variant="secondary" disabled={busy} onClick={() => void run(() => admin.signOut(), () => void load())}>
                Sign out
              </Button>
            )}
          </ButtonGroup>
          <p className="govuk-body-s prt-meta">
            The test makes one real call for a single token against whatever is configured now.
            &ldquo;Saved&rdquo; is not the same claim as &ldquo;reachable&rdquo;: a bridge on
            another machine, an expired key and a renamed deployment all look identical until
            something asks.
          </p>
        </div>
      </div>

      {!config.pinned ? (
        <section aria-labelledby="admin-active">
          <h2 className="govuk-heading-m" id="admin-active">Which service answers</h2>
          <div className="govuk-grid-row">
            <div className="govuk-grid-column-two-thirds">
              <Radios
                id="admin-provider"
                legend="Use this one"
                legendSize="s"
                hint="Changing this takes effect on the next model call. Nothing already running is affected."
                value={config.active}
                onChange={(id) => void run(() => admin.use(id), setConfig)}
                items={config.providers.map((p) => ({ value: p.id, text: p.label, hint: p.blurb }))}
              />
            </div>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="admin-ceiling">
        <h2 className="govuk-heading-m" id="admin-ceiling">What one run may spend</h2>
        <div className="govuk-grid-row">
          <div className="govuk-grid-column-two-thirds">
            {/*
              A SUBSCRIPTION COSTS NO MONEY PER CALL, which is what makes it
              dangerous. Every run on 2026-09-19 reported "$0.00 spent" —
              truthfully — while consuming 77% of a weekly allowance between
              them, because nothing counted what was not billed.
              A run that passes this ceiling is stopped by the code that spends,
              not by whoever happens to be watching. What it finished is kept.
            */}
            <p className="govuk-body">
              A run billed to a subscription costs nothing per call, so nothing stops it if it goes
              wrong. This does. A run that passes the ceiling is stopped where it stands and keeps
              the stages it finished — you can raise this and resume.
            </p>
            {/* ONE MEASUREMENT, NOT THREE. This sentence, the Standard depth
                hint on `/assessments/new` and the landing table's "Ran for"
                column all describe the same run, and the three disagreed: this
                page and the commissioning page each froze their own copy of the
                token figure, and the commissioning page's duration was out by a
                factor of four. `client/measured.ts` holds it once, with the
                arithmetic that produced it. */}
            <p className="govuk-body-s prt-meta">
              {MEASURED_SCALE} Leave it at 0 for no ceiling.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const value = Number(new FormData(e.currentTarget).get('tokens'));
                void run(() => admin.setCeiling(value), (next) => {
                  setConfig(next);
                  setOutcome(value > 0 ? `A run may now use ${value.toLocaleString()} tokens.` : 'No ceiling — a run may use as much as it needs.');
                });
              }}
              noValidate
            >
              <Input
                id="token-ceiling"
                name="tokens"
                type="number"
                label="Token ceiling for one run"
                labelSize="s"
                hint="0 for no ceiling."
                defaultValue={String(config.tokenCeiling ?? 0)}
                disabled={busy}
              />
              <ButtonGroup>
                <Button type="submit" disabled={busy}>Save the ceiling</Button>
              </ButtonGroup>
            </form>
          </div>
        </div>
      </section>

      <ModelMenu
        config={config}
        busy={busy}
        onSave={(models) => void run(() => admin.saveModels(models), (next) => {
          setConfig(next);
          setOutcome(
            models.length
              ? `The picker now offers ${models.length} ${models.length === 1 ? 'model' : 'models'}.`
              : 'The picker is back to the models this build ships with.',
          );
        })}
      />

      {config.providers.map((provider) => (
        <ProviderForm
          key={provider.id}
          provider={provider}
          active={provider.id === config.active}
          fromEnvironment={provider.id === config.active ? config.fromEnvironment : []}
          busy={busy}
          version={saved}
          onSave={(values) => void run(() => admin.save(provider.id, values), (next) => {
            setConfig(next);
            setSaved((n) => n + 1);
            setOutcome(`${provider.label} saved. Any key you entered is stored and will not be shown again.`);
          })}
        />
      ))}
    </>
  );
}

/**
 * One provider's fields.
 *
 * A SECRET'S BOX IS ALWAYS EMPTY and says whether one is stored beside it. The
 * alternative — pre-filling with dots — invites a reader to believe they can
 * check what they pasted, and leaves the page unable to tell "unchanged" from
 * "cleared" when they submit it.
 */
function ProviderForm({ provider, active, fromEnvironment, busy, version, onSave }: {
  provider: ProviderView;
  active: boolean;
  fromEnvironment: string[];
  busy: boolean;
  /** Changes on every successful save, remounting the form so a typed secret leaves the box. */
  version: number;
  onSave: (values: Record<string, string>) => void;
}) {
  /*
   * WHAT HAS BEEN ANSWERED SO FAR, so `showWhen` can hide what this answer does
   * not need.
   *
   * Azure has four ways to authenticate and between them eight fields; a reader
   * using a key fills in one of the eight and should be shown one. The
   * alternative — every field always — is a form where the way to succeed is to
   * know which boxes to ignore.
   *
   * ONLY THE CONTROLLING FIELDS ARE HELD IN STATE. Everything else stays
   * uncontrolled, because a controlled secret puts the value into React state,
   * which is the one thing this page exists not to do.
   */
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const controlling = new Set(provider.fields.flatMap((f) => (f.showWhen ? [f.showWhen.field] : [])));

  /**
   * READ THE VALUE NOW, NOT INSIDE THE UPDATER.
   *
   * `setAnswers((a) => ({ ...a, [name]: e.currentTarget.value }))` looks
   * idiomatic and is a crash. React pools the synthetic event and nulls
   * `currentTarget` once the handler returns, and a functional updater is
   * evaluated LATER — during the render that processes the queue. So the read
   * happens after the nulling and throws "Cannot read properties of null", from
   * inside React's own state machinery where the stack names `useState` and not
   * the handler that queued it.
   *
   * The whole panel unmounts, which in a browser test looks like the element
   * simply never appearing. Taking the string first is the entire fix.
   */
  const remember = (name: string, value: string) => setAnswers((a) => ({ ...a, [name]: value }));

  /** A select's first option is its default when nothing is stored — the server agrees. */
  const answerFor = (name: string): string => {
    if (answers[name] !== undefined) return answers[name];
    const stored = provider.values[name];
    if (typeof stored === 'string' && stored.trim()) return stored;
    const field = provider.fields.find((f) => f.name === name);
    return field?.options?.[0]?.value ?? '';
  };

  const visible = (field: ProviderView['fields'][number]): boolean =>
    !field.showWhen || field.showWhen.is.includes(answerFor(field.showWhen.field));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values: Record<string, string> = {};
    for (const field of provider.fields) {
      // A HIDDEN FIELD IS NOT SENT, so it keeps whatever is stored rather than
      // being cleared. Switching from an app registration to a key must not
      // silently delete the client secret — a reader switching back would find
      // it gone with nothing having said so.
      if (!visible(field)) continue;
      const raw = form.get(field.name);
      const value = typeof raw === 'string' ? raw : '';
      // A SECRET LEFT BLANK IS "LEAVE IT ALONE", not "clear it" — the box is
      // always empty, so treating blank as a deletion would wipe a key every
      // time somebody edited the field beside it. Clearing has its own control.
      if (field.secret && !value.trim() && provider.values[field.name] === true) continue;
      values[field.name] = value;
    }
    onSave(values);
  }

  return (
    <section aria-labelledby={`admin-${provider.id}`}>
      <h2 className="govuk-heading-m" id={`admin-${provider.id}`}>
        {provider.label} {active ? <Tag colour="blue">In use</Tag> : null}
      </h2>
      <div className="govuk-grid-row">
        <div className="govuk-grid-column-two-thirds">
          <p className="govuk-body">{provider.blurb}</p>
          <form key={version} onSubmit={submit} noValidate>
            {provider.fields.map((field) => {
              const stored = provider.values[field.name];
              const fromEnv = fromEnvironment.includes(field.name);
              if (!visible(field)) return null;

              if (field.kind === 'select') {
                return (
                  <Select
                    key={field.name}
                    id={`${provider.id}-${field.name}`}
                    name={field.name}
                    label={field.label}
                    labelSize="s"
                    hint={
                      <>
                        {field.hint}
                        {fromEnv ? (
                          <>
                            {' '}
                            <strong>Set in the environment on the server</strong>, which wins over
                            anything saved here — so this field is not editable.
                          </>
                        ) : null}
                      </>
                    }
                    options={(field.options ?? []).map((o) => ({ value: o.value, text: o.text }))}
                    value={answerFor(field.name)}
                    onChange={(e) => remember(field.name, e.currentTarget.value)}
                    disabled={busy || fromEnv}
                  />
                );
              }

              return (
                <Input
                  key={field.name}
                  id={`${provider.id}-${field.name}`}
                  name={field.name}
                  type={field.secret ? 'password' : 'text'}
                  label={field.label}
                  labelSize="s"
                  autoComplete="off"
                  placeholder={field.placeholder}
                  defaultValue={field.secret ? '' : typeof stored === 'string' ? stored : ''}
                  disabled={busy || fromEnv}
                  {...(controlling.has(field.name)
                    ? {
                        value: answerFor(field.name),
                        onChange: (e: { currentTarget: { value: string } }) =>
                          remember(field.name, e.currentTarget.value),
                      }
                    : {})}
                  hint={
                    <>
                      {field.hint}
                      {field.secret ? (
                        <>
                          {' '}
                          {stored === true
                            ? 'One is stored. Leave this blank to keep it, or type a new one to replace it.'
                            : 'Nothing is stored.'}{' '}
                          It is never shown again once saved.
                        </>
                      ) : null}
                      {fromEnv ? (
                        <>
                          {' '}
                          <strong>Set in the environment on the server</strong>, which wins over
                          anything saved here — so this field is not editable.
                        </>
                      ) : null}
                    </>
                  }
                />
              );
            })}
            <ButtonGroup>
              <Button type="submit" disabled={busy}>Save {provider.label}</Button>
            </ButtonGroup>
          </form>

          {provider.models.length ? (
            <Details summary={`What this offers — ${provider.models.length}`}>
              <ul className="govuk-list govuk-list--bullet">
                {provider.models.map((model) => (
                  <li key={model.id}>
                    <strong>{model.name}</strong> <span className="prt-meta">{model.note}</span>
                  </li>
                ))}
              </ul>
            </Details>
          ) : (
            <p className="govuk-body-s prt-meta">
              Nothing configured yet, so this offers nothing to the model picker.
            </p>
          )}

          {provider.id === 'codex' ? (
            <WarningText>
              A bridge is reachable from the machine running this service, not from yours. If this
              service is on another box, a loopback address here will never connect.
            </WarningText>
          ) : null}
        </div>
      </div>
    </section>
  );
}
