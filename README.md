# Policy Red Team on Databricks Apps

Reads a policy paper as an adversary would: who gains if it fails, and what they
can do about it while staying compliant. This branch runs it as a
[Databricks App](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/),
with its model calls going to
[Model Serving](https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/)
and its data kept in [Lakebase](https://docs.databricks.com/aws/en/oltp/).

It is **not an assurance review**. A clean report means it found nothing, which
is not the same as a policy being fine. Every profile it writes is a hypothesis
about a body's incentives, never a finding about a named person.

It is deployed with a [bundle](https://docs.databricks.com/aws/en/dev-tools/bundles/)
(`databricks.yml`). One deploy sets up everything:

| | |
|---|---|
| **The app** | built on your machine and uploaded ready to run |
| **A Lakebase database** | [Lakebase](https://docs.databricks.com/aws/en/oltp/) Postgres, where the assessments are kept. Created on the first deploy |
| **A model endpoint** | a [Model Serving](https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/) chat endpoint, called as the app's own service principal. No API key anywhere |
| **Two secrets** | the `/admin` password and the settings encryption key, generated for you |

## Quick start

Two lines, once you have the CLI and Node 22 (see [Before you start](#before-you-start)):

```bash
databricks auth login --host https://<your-workspace>.cloud.databricks.com --profile <profile>
npm run deploy -- <profile>
```

`npm run deploy` does steps 2 to 5 below in one go and prints the app's URL and
how to read the admin password. Run the same command again to deploy a code
change. The first time, finish with [steps 6 to 8](#deploy-it-step-by-step):
read the password, set a token ceiling in `/admin`, and share the app.

## Before you start

You need:

- **The Databricks CLI**, v1.17 or newer. [Install it](https://docs.databricks.com/aws/en/dev-tools/cli/install).
- **Node 22.23.2 or newer** on your machine (`node --version`). The app is built
  here, not on the platform.
- **In the workspace:** Databricks Apps, Lakebase, and a chat endpoint you can
  query. Check with `databricks serving-endpoints list -p <profile>`.
- **Permission to create** an app, a Lakebase project and a secret scope.

## Deploy it, step by step

The bundle deploys to whichever workspace your CLI profile points at. Nothing in
the repository names a workspace.

**1. Log in to the workspace** and give the login a name (the profile):

```bash
databricks auth login --host https://<your-workspace>.cloud.databricks.com --profile <profile>
```

**2. Install the build tools**, once:

```bash
npm ci
```

**3. Create the secrets**, once per workspace. This makes the secret scope and
generates the admin password and settings key. Running it again changes nothing:

```bash
databricks bundle run init_secrets -t dev -p <profile>
```

**4. Deploy.** This builds the app, uploads it, and creates the Lakebase database
and the app. The first time takes a few minutes:

```bash
databricks bundle deploy -t dev -p <profile>
```

**5. Start it.** This puts the code live and prints the app's URL:

```bash
databricks bundle run policy_red_team -t dev -p <profile>
```

**6. Get the admin password** (step 3 generated it without printing it):

```bash
databricks secrets get-secret policy-red-team admin-password -p <profile> -o json \
  | python3 -c "import json,sys,base64; print(base64.b64decode(json.load(sys.stdin)['value']).decode())"
```

**7. Set a spending limit.** Open `<app URL>/admin`, sign in with that password
and set a token ceiling before anyone runs anything. Without one a run keeps
spending. See [What it costs](#what-it-costs).

**8. Share it.** At first only you can open it. Give colleagues `CAN_USE` in the
Apps UI, or uncomment `permissions` in `databricks.yml` and repeat step 4. See
[app permissions](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/permissions).

To test it, open the app, choose **Assess a paper** and upload a PDF, DOCX or text
file. Progress shows stage by stage.

## After a code change

`npm run deploy -- <profile>` again, or steps 4 and 5 by hand:

```bash
databricks bundle deploy -t dev -p <profile>
databricks bundle run policy_red_team -t dev -p <profile>
```

`deploy` only uploads. **`run` restarts the app onto the new code.** A run in
progress loses the model call it was making (still billed) and then carries on
from its stage, so avoid redeploying during a run that matters.

## Another workspace

Log in to it with a new profile (step 1) and run `npm run deploy -- <new profile>`. To pin a workspace or change a setting for it, add a target to
`databricks.yml` and use `-t <target>`:

```yaml
targets:
  prod:
    mode: production
    workspace:
      host: https://<workspace>.cloud.databricks.com
      root_path: /Workspace/Shared/.bundle/${bundle.name}/${bundle.target}
    variables:
      serving_endpoint: databricks-claude-sonnet-5
```

## What you can change

In `databricks.yml`, per target:

| Variable | Default | |
|---|---|---|
| `app_name` | `policy-red-team` | lower case and hyphens, 26 characters at most |
| `serving_endpoint` | `databricks-claude-sonnet-5` | the endpoint every model call goes to |
| `lakebase_project` | `policy-red-team` | created if it does not exist |
| `secret_scope` | `policy-red-team` | holds `admin-password` and `settings-key` |

In `app.yaml`, for how the app behaves:

| Setting | Default | |
|---|---|---|
| `POLICY_SEARCH` | `none` | the research stage has no web search, and the report says every finding rests on the paper. Set `tavily` and add a `TAVILY_API_KEY` secret if outbound access to [Tavily](https://tavily.com) is agreed |
| `POLICY_OWNER_EMAIL` | a placeholder | assessments are scoped to one owner. Everyone with access sees the same list, and the store allows three active assessments per owner, so the whole team shares three |
| `POLICY_WORKERS` | `2` | how many documents can be assessed at once, 1 to 6 |
| `POLICY_DATABRICKS_PROMPT_CACHE` | `0` | `1` turns on Claude prompt caching, as an experiment. See [What it costs](#what-it-costs) |

**Parallel calls within a run** are chosen per submission on the form: "Parallel model
calls", 1 to 6, four by default. Upstream measured four as the point past which more
stop helping. The tokens spent are the same at any setting; only the time changes. The
endpoint sees up to `POLICY_WORKERS` times that number of calls at once.

**Changing the model.** Change `serving_endpoint`, then deploy and run. These
endpoint families have been tested and all return usable JSON: Claude, GPT-5,
gpt-oss, Gemini, Llama, Qwen, GLM, DeepSeek and Kimi. Claude and Gemini need
their replies adjusted, which the provider does. See [How Model Serving
differs](#how-model-serving-differs).

## What it costs

A run is billed to the workspace as Model Serving usage. For a sense of scale,
a run on a one-page sample document with Claude Sonnet 5 had used about 1.1
million tokens by stage 9 of 18. That was already more than the app's own
estimate for the whole run. A real policy paper costs more.

- **Prompt caching is off by default.** The pipeline was tuned on a service
  that caches the shared context between calls. Claude on Model Serving accepts
  cache markers, and `POLICY_DATABRICKS_PROMPT_CACHE=1` sends them at the
  prefix each call shares with the last. But a probe found only 1 cache read in
  4 identical calls, apparently because requests are spread across backends,
  and a cache write costs more than a plain read. Try it on one run and compare
  the "served from cache" figure (now reported truthfully) before leaving it on.
- **Set a token ceiling in `/admin`.** It is the one control inside the app.
- **Put limits on the endpoint.** Its [Unity Gateway](https://docs.databricks.com/aws/en/ai-gateway/)
  settings in the Serving UI give rate limits, usage tracking and inference
  tables. Worth doing before sharing the app: a single run can make hundreds of
  calls.
- **Cancel runs you do not need** from the assessment page. A cancelled run
  stops spending straight away.

## Running it

| | |
|---|---|
| Status and URL | `databricks apps get policy-red-team` |
| Logs | `databricks apps logs policy-red-team --follow`. Needs an OAuth profile, not a personal access token |
| Where the data is | Lakebase project `policy-red-team`, database `databricks_postgres`, schema `policy_red_team` |
| Backups | Lakebase keeps branch history (seven days by default). See [Lakebase projects](https://docs.databricks.com/aws/en/oltp/projects/) |
| Removing it | `databricks bundle destroy -t dev` removes the app. The Lakebase project is marked `prevent_destroy` and the secret scope is outside the bundle, so both stay until deleted by hand |

## When something goes wrong

| Symptom | Cause, and what to do |
|---|---|
| Deploy fails at "Installing packages" with an `npm error 404` | The repository was deployed, not the staged build. `source_code_path` must be `./.app`, and `bundle deploy` must have run its prebuild. Deploying the repository makes the platform run `npm install` through Databricks' registry mirror, which refuses packages at random |
| The prebuild fails before anything uploads | Node is missing or older than 22 on this machine, or `npm ci` has not been run |
| The app shows old behaviour after a deploy | Run `databricks bundle run policy_red_team`. `deploy` only uploads |
| The app fails to start after a deploy, and says it cannot read its secrets | Its service principal has lost READ on the scope. Put it back with `databricks secrets put-acl policy-red-team <service principal client ID> READ`. The client ID is in `databricks apps get policy-red-team` |
| A stage fails with "the model's reply was cut off at its output limit" | The call used its whole output allowance. For Claude that is 48,000 tokens, and a request that was cut off once is given 64,000 on its next attempt (`src/lib/llm/providers/databricks.ts`). If it still fails, the paper needs a model with a larger output limit for that stage |
| A call error reads "400 status code (no body)" | It should not any more: the provider reshapes Databricks' error body so the endpoint's own message is recorded. If you see it, the endpoint sent a body in a shape nobody has seen yet |
| You want to see what a run is doing | `databricks apps logs policy-red-team --follow` shows one `serving:` line per model call: seconds, tokens in and out, cached, and how the reply finished |
| Submitting says "Three analyses are already active" | The store's limit per owner. Every reader on the app is the same owner, so cancel or wait for one of the three |
| The app shows CRASHED after a restart | Check `databricks apps logs` for the cause. A transient Lakebase credential timeout used to crash it; the pool now logs and retries those. `databricks bundle run policy_red_team` starts it again |
| Stage calls fail with "the model returned malformed JSON" | The endpoint is replying in a shape the provider does not yet handle. Try a different family in `serving_endpoint` and report which endpoint it was |
| A script or `curl` gets "This request came from another website" | That is the cross-site guard. A browser sends `Sec-Fetch-Site: same-origin` and is let through; a script has to send the same header |

## How it differs from running it locally

| | |
|---|---|
| **The database is Lakebase** | An app's filesystem does not survive a restart. `POLICY_DATABASE=lakebase` switches `src/lib/db` from PGlite to a Lakebase pool, whose connection and OAuth password come from the app's `postgres` resource. The tables live in their own schema, `POLICY_PG_SCHEMA`, and the migration runner points upstream's hard-coded `"public".` references at it |
| **Models are Model Serving** | The `databricks` provider calls `<workspace>/serving-endpoints` with the app's service principal token, refreshed before it expires |
| **The workspace sign-in is the gate** | Every request has already passed the Databricks login, and `CAN_USE` on the app decides who that is. So `POLICY_ACCESS=open`. `/admin` keeps its own password |
| **Nothing is installed on the platform** | `npm run stage:app` builds the client and one minified server bundle, with every dependency inside it, into `.app/`, with a `package.json` that lists none. The bundle is 5.6MB, under the platform's 10MB-per-file limit. It cannot carry PGlite's WebAssembly, which is why the staged build is Lakebase only |

## How Model Serving differs

Measured against the endpoints in a workspace on 2026-09-24, and handled in
`src/lib/llm/providers/databricks.ts`:

- **Claude refuses `response_format: json_object`.** The provider drops it.
  Claude then puts its JSON in a markdown code fence, which the provider
  unwraps before the pipeline sees it. `json_schema` with an open schema was
  tried too: Claude then wraps the whole answer in a key it makes up.
- **Claude and Gemini return `content` as a list of parts.** Claude's includes
  a reasoning part. The provider keeps the text and joins it.
- **Claude's reasoning spends its output budget.** It thinks inside the reply,
  so the pipeline's 25,000-token cap on a call was used up by the longest
  stages: the first two real runs each lost their final stage at exactly
  25,000. Claude is given 48,000 tokens and 660 seconds a call (64,000 on a retry), sized on the
  roughly 110 tokens a second it produced on those runs.
- **Only the OpenAI reasoning families take `reasoning_effort`.** The
  pipeline's OpenRouter-style `reasoning` setting is translated for those and
  dropped for everything else.
- **Errors come back in a different shape** (`{error_code, message}`), which the
  OpenAI SDK reports as `400 status code (no body)`. The provider reshapes them
  so the endpoint's own message is recorded, and drops a field only when the
  message names it.

## Not yet supported on Apps

- **Sealed runs.** Their keys are files on local disk, and an app's disk is
  wiped on restart. Leave sealing off until the keys have somewhere durable to
  live, such as a Unity Catalog volume.
- **Finishing a stage on shutdown.** The platform gives a stopping app fifteen
  seconds, not the minutes a stage can take. After ten, the app hands its
  claimed stages back to the queue so the next instance picks them up at once;
  the call in flight is lost and billed, and the stage resumes.

## Why the secret scope is not a bundle resource

A bundle that manages a secret scope's permissions replaces the whole access
list. On the first attempt that removed the READ access the app's own
`secret` resources had granted it, so the next restart would have come up
without its secrets. Naming the app's principal in the bundle's list does not
work either, because the reference is not resolved there. So `init_secrets`
creates the scope, and the app's resource declarations grant the only access
it needs. See [secret management](https://docs.databricks.com/aws/en/security/secrets/).

## What it does

Eighteen durable stages, one at a time, resumable across restarts:

| | |
|---|---|
| **Read the paper** | ingestion · decomposition · entity resolution · knowledge graph |
| **Work out who is in it** | actor and incentive profiles |
| **Test it against the world** | targeted research · evidence matrix · interaction models · automated policy tests |
| **Attack it** | adversarial scenarios · **exploitation playbook** · cross-policy exposure |
| **Write it up, then challenge it** | synthesis · persona library · theory of change · options · independent challenge · assured synthesis |

The exploitation playbook is the red team. Per profiled body, the concrete plays
it can run to serve itself at the policy's expense — preferring the ones that stay
**compliant**, because those are the ones nothing will stop. The model judges four
factors, and the server computes the ranking as their geometric mean: a play that
scores high on three and near zero on one is not a threat, and an average would
hide that.

A finished assessment can be read in the browser, downloaded as Word or markdown,
or taken away as a pack that opens by double-clicking it and needs no network at
all.

## Developing it

```
npm ci                 install the build tools
npm run deploy -- <profile> [target]   secrets, build, upload and restart, in one go
npm run stage:app      build the app into .app/ (bundle deploy runs this for you)
npm test               unit tests, no database
npm run test:all       every gate: unit, integration, accessibility, browser walk, offline pack
```

The browser gates need `npx playwright install chromium`. `.env.example` is for
running it on your own machine only; a Databricks App takes its settings from
`app.yaml` and never reads a `.env` file. `docs/databricks-architecture.html`
shows how the parts fit together on Databricks. `AGENTS.md` lists the things that
will cost you an hour if nobody says them.

This is a fork: most of the analysis pipeline is copied from an upstream project,
and `docs/upstream.json` names every copied file. Change those through
`scripts/sync-core.mjs`, not by hand. See `AGENTS.md`.

## Not a government service

This is styled with the GOV.UK Design System because the design system is good at
documents and forms, which is what this is. It is **not a government service** and
has no connection with any government department.

The GOV.UK crown, the royal arms and the GDS Transport typeface are deliberately
not used — they are licensed to services on GOV.UK. Text is set in the fallback
stack GOV.UK itself specifies off GOV.UK. `npm run a11y` asserts all of that
against the built files, because it is a promise about what ships rather than a
setting someone might change.

Accessibility is checked with axe-core against WCAG 2.2 AA on every route, and the
browser walk checks the pages that only exist while a run is in flight. The
[accessibility statement](/accessibility) names the two places this departs from
the application it was forked from: hovering became clicking, and every diagram
ships with the same data as a table.

## Licence

MIT. See `LICENCE`.

GOV.UK Frontend is used under the MIT Licence. Its crown, coat of arms and
typeface are not used.
