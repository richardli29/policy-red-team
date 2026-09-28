import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type AnalysisRow, type OfferedModel } from '../api';
import { Button, ButtonGroup, Details, ErrorSummary, FileUpload, Input, Radios, Select, Textarea, WarningText } from '../govuk';
import { MEASURED_RUN, MEASURED_STANDARD_HINT } from '../measured';
import { isFinished, spent } from '../status';
import { usePageTitle } from '../layout/Template';

/**
 * Commissioning an assessment.
 *
 * ONE PAGE, NOT ONE QUESTION PER PAGE, and that is a departure from GOV.UK's
 * default worth being explicit about. One-thing-per-page exists for services
 * where the person filling the form is doing it once, under stress, possibly on a
 * phone. This is a tool its owner uses repeatedly and deliberately, and eight
 * pages to start a run they will start again tomorrow is friction with nothing on
 * the other side of it. The grouping, the hints and the error summary are kept;
 * the pagination is not.
 *
 * Everything except the paper itself degrades. A model this build cannot reach,
 * an effort it will not take, an unknown depth — each falls back to a default
 * rather than failing a submission over a dropdown. Sealing is the one field that
 * does not, because a reader who ticked the box and got an unsealed run would
 * have handed an unpublished paper to a system they were told would destroy it.
 */
export function New() {
  usePageTitle('Assess a paper');
  const navigate = useNavigate();
  // The landing page hides the way in; this page is still directly addressable,
  // and a full form that can only 403 on submit is the control that argument
  // was made against.
  const [readOnly, setReadOnly] = useState(false);
  const [models, setModels] = useState<OfferedModel[]>([]);
  /**
   * Every run this install holds, only so the hint can point at the one it
   * describes. `AnalysisRow` carries no depth, no call count and no token
   * total — see `client/measured.ts` for why the figures themselves are
   * constants — but it does carry the two timestamps, so the DURATION the
   * reader is being quoted is one they can check for themselves in a click.
   */
  const [runs, setRuns] = useState<AnalysisRow[]>([]);
  const [depth, setDepth] = useState('standard');
  const [sealed, setSealed] = useState(false);
  const [errors, setErrors] = useState<{ text: string; href: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.landing()
      .then((data) => { setModels(data.models); setRuns(data.analyses); setReadOnly(data.readOnly); })
      .catch(() => setModels([]));
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    // Checked here as well as on the server, because an error summary that
    // appears without a round trip is the difference between a form that feels
    // broken and one that feels answered.
    const found: { text: string; href: string }[] = [];
    if (!String(form.get('title') ?? '').trim()) found.push({ text: 'Enter a title for this assessment', href: '#title' });
    const file = form.get('document');
    if (!(file instanceof File) || !file.size) found.push({ text: 'Select the paper to assess', href: '#document' });
    setErrors(found);
    if (found.length) return;

    form.set('depth', depth);
    form.set('sealed', sealed ? 'sealed' : '');
    setSubmitting(true);
    try {
      const { id } = await api.submit(form);
      void navigate(`/assessments/${id}`);
    } catch (err) {
      setErrors([{ text: (err as Error).message, href: '#document' }]);
      setSubmitting(false);
    }
  }

  if (readOnly) {
    return (
      <div className="govuk-grid-row">
        <div className="govuk-grid-column-two-thirds">
          <h1 className="govuk-heading-xl">Assess a paper</h1>
          <p className="govuk-body-l">
            Not from this copy. It is read-only: you can open, drill into and download every
            assessment here, but nothing new can be started.
          </p>
          <p className="govuk-body">
            <Link className="govuk-link" to="/">Go back to the assessments</Link>
          </p>
        </div>
      </div>
    );
  }

  /** The longest finished run — which is the one the Standard figures describe. */
  const longest = runs
    .filter((row) => isFinished(row.status))
    .reduce<AnalysisRow | null>((best, row) => {
      const ran = new Date(row.updatedAt).getTime() - new Date(row.createdAt).getTime();
      const bestRan = best ? new Date(best.updatedAt).getTime() - new Date(best.createdAt).getTime() : -1;
      return Number.isFinite(ran) && ran > bestRan ? row : best;
    }, null);

  return (
    <div className="govuk-grid-row">
      <div className="govuk-grid-column-two-thirds">
        <ErrorSummary errors={errors} />
        <h1 className="govuk-heading-xl">Assess a paper</h1>

        <form onSubmit={onSubmit} noValidate>
          <Input id="title" label="What is this paper called?" labelSize="s"
                 hint="Use the title on the front of the document." />
          <FileUpload id="document" name="document" label="The paper" labelSize="s"
                      hint="PDF, DOCX or UTF-8 text, up to 10 MB. It must have a text layer — a scan of a page yields nothing."
                      accept=".pdf,.docx,.txt" />
          <Input id="jurisdiction" label="Jurisdiction" labelSize="s"
                 hint="Optional. England, Scotland, Wales, Northern Ireland, or UK-wide." />
          <Input id="policyArea" name="policyArea" label="Policy area" labelSize="s" hint="Optional." />
          <Textarea id="context" label="Anything the paper does not say" labelSize="s" rows={4}
                    hint="Optional. What you already know that the assessment should take into account." />

          {/*
            WHAT IT COSTS, IN THE NUMBERS THE APP ALREADY KNOWS.
            This page spends the money and was the only one that would not say
            how much: "costs more", "this is a bill, not a rounding error", and
            not a figure, a duration or a unit anywhere on it — while the admin
            panel, which only sets a ceiling, prints "about 61 million tokens"
            three clicks away. The standard figure is the last full run measured
            end to end. Deep has no measured multiplier, so none is claimed.
          */}
          <Radios
            id="depth" legend="How deeply should it read?" legendSize="s"
            hint="A deep read follows each line of enquiry further, and costs more."
            value={depth} onChange={setDepth}
            items={[
              {
                value: 'standard',
                text: 'Standard',
                /*
                  THIS SAID "took two and a half hours" AND THE LANDING TABLE
                  SAID 10h 23m OF THE SAME RUN. The 2.5 hours is stages 1 to 17;
                  the missing 8h 18m is the final synthesis alone, and the
                  figure a reader was shown before spending the money was the
                  smaller one. `client/measured.ts` holds the measurement once,
                  for this hint and for the ceiling page that quoted it a third
                  way.
                */
                hint: MEASURED_STANDARD_HINT,
              },
              {
                value: 'deep',
                text: 'Deep',
                hint: 'Keeps going until a line of enquiry stops producing new evidence. More calls than standard, by an amount that depends on the paper — this build has not measured one end to end.',
              },
            ]}
          />

          {/*
            WHERE THE FIGURES COME FROM, because a figure a reader cannot check
            is a figure they have to take on trust — the same argument `RunClock`
            makes about showing its working. The run is found rather than named
            by id: a hard-coded assessment id would 404 on any install but this
            one, and the longest finished run IS the one the figures describe.
          */}
          <Details summary="Where these figures come from">
            <p className="govuk-body-s">
              They were read off one assessment: {MEASURED_RUN.passages} passages,{' '}
              {MEASURED_RUN.stages} stages, {MEASURED_RUN.calls} model calls and about{' '}
              {MEASURED_RUN.tokensAbout} tokens, run on {MEASURED_RUN.when}. The call and token
              totals are not on this page&rsquo;s response and are written down rather than
              computed here.
            </p>
            {longest ? (
              <p className="govuk-body-s">
                <Link className="govuk-link" to={`/assessments/${longest.id}`}>{longest.title}</Link>{' '}
                <span className="prt-meta">
                  ran for {spent(longest.createdAt, longest.updatedAt)}
                </span>
              </p>
            ) : (
              <p className="govuk-body-s prt-meta">
                That run is not in this copy, so the duration above cannot be checked here.
              </p>
            )}
          </Details>

          {models.length ? (
            <Select
              id="model" label="Which model?" labelSize="s"
              hint="Optional. Leave it alone and the configured default is used. Decomposition makes one call per passage, so this is a bill, not a rounding error."
              /*
                A FLOATING ID SAYS SO HERE TOO. `~deepseek/…` is an alias whose
                model changes without the id changing, so two assessments a month
                apart are not comparable even though the provenance section names
                the same thing. The menu page marks them with a tag and a
                paragraph; the page that actually commissions a run — where the
                argument applies with more force — dropped the tilde, the id and
                the note, and offered them as five peers.
              */
              options={[
                { value: '', text: 'Use the default' },
                ...models.map((m) => ({
                  value: m.id,
                  text: `${m.name} — ${m.tier}${m.id.startsWith('~') ? ' (floating: the model behind it can change)' : ''}`,
                })),
              ]}
            />
          ) : null}

          {/*
            PARALLEL CALLS WERE NEVER ASKED FOR, so every run was serial. The
            pipeline has taken `concurrency` since upstream added it; this form
            did not send it, `ingest.ts` read the absence as null and the run
            fell to `DEFAULT_CONCURRENCY`, one call at a time. On 2026-09-24 the
            fan-out stages were about 3,600 of a 6,000-second run for exactly
            that reason. Four is what upstream measured as the point past which
            more agents stop helping; the tokens spent are the same at any
            setting.
          */}
          <Select
            id="concurrency" label="Parallel model calls" labelSize="s"
            hint="How many calls a stage makes at once. More finishes sooner and costs the same, but puts more load on the model endpoint at one time."
            defaultValue="4"
            options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), text: n === 1 ? '1 (one at a time)' : n === 4 ? '4 (recommended)' : String(n) }))}
          />

          <div className="govuk-form-group">
            <fieldset className="govuk-fieldset">
              <legend className="govuk-fieldset__legend govuk-fieldset__legend--s">Sealing</legend>
              <div className="govuk-checkboxes govuk-checkboxes--small" data-module="govuk-checkboxes">
                <div className="govuk-checkboxes__item">
                  <input className="govuk-checkboxes__input" id="sealed" type="checkbox"
                         checked={sealed} onChange={(e) => setSealed(e.currentTarget.checked)}
                         aria-describedby="sealed-hint" />
                  <label className="govuk-label govuk-checkboxes__label" htmlFor="sealed">
                    Seal this assessment
                  </label>
                  <div id="sealed-hint" className="govuk-hint govuk-checkboxes__hint">
                    None of the paper is written to the database in the clear.
                  </div>
                </div>
              </div>
            </fieldset>
          </div>

          {sealed ? (
            <WarningText>
              Destroying the key destroys the run. There is no recovery, by design — back up the
              key directory deliberately or accept that a purge is final.
            </WarningText>
          ) : null}

          <ButtonGroup>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Starting…' : 'Start the assessment'}
            </Button>
            <a className="govuk-link" href="/">Cancel</a>
          </ButtonGroup>
          {/*
            THE WAIT IS NARRATED. A 10 MB PDF goes up with no progress and no
            announcement: the only signal was a button that went disabled — losing
            focus as it did — with its label changed. Seven other places in this
            client already carry a live region for exactly this.
          */}
          <p className="govuk-body prt-meta" role="status">
            {submitting ? 'Sending the paper and starting the run. This can take a moment for a large file.' : ''}
          </p>
        </form>
      </div>
    </div>
  );
}
