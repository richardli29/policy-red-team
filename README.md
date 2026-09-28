# Policy Red Team

Reads a policy paper as an adversary would: who gains if it fails, and what they
can do about it while staying compliant.

It is **not an assurance review**. It will not tell you a policy is fine — a clean
report means it found nothing, which is not the same thing. Every profile it
writes is a hypothesis about a body's incentives, never a finding about a named
person.

The database is embedded in the application. There is no database server to run,
no cache, no second process, and nothing to install beyond Node.

## Run it

```bash
npm install
npm start                   # http://127.0.0.1:5290
```

Then open `/setup`. It will ask you to set an admin password — the service ships
accepting `admin` / `admin`, once, and the only thing that credential can do is
replace itself — and then walk you through connecting a model.

Node 22.23.2 or newer. Why that exact floor: `pdfjs-dist` calls `Promise.try` and
`Uint8Array.toHex`, which are ES2025 and not in earlier releases.
`src/lib/polyfills.ts` carries both so the test suite runs on 22.22, but do not
rely on that in production.

### Or try it without a key, a bill, or a network

```bash
npm run assess:fixture -- tests/fixtures/policy-analysis/policy.txt
```

That runs all eighteen stages against a deterministic fixture model and writes a
report. The fixture build is compiled with **no path to a model provider or a
search service at all**, and the build fails if one survives into the bytes — so
it is a checkable claim rather than a promise.

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

## Configuring it

There are three ways in, and they have a strict order of precedence:

> **the environment beats the stored settings beats the built-in defaults**

A value in the environment wins, always, and the page that would otherwise edit
it says so rather than accepting a change that will not take effect. That is what
lets a deployment managed by Ansible or systemd keep behaving the way its files
say it does.

| | |
|---|---|
| **`/setup`** | a guided journey — one thing per page, a task list, and a real call at the end |
| **`/admin`** | the same settings on one page, for when you know what you are changing |
| **the environment** | for a deployment whose configuration is managed elsewhere |

Both pages are behind the admin password. Everything else is as open as this
install is configured to be — see **Who can reach it** below.

### Which service answers

One module per service. `POLICY_PROVIDERS` narrows the list a build offers
without a rebuild, which is how you ship this without the Codex entry:
`POLICY_PROVIDERS=openrouter,azure`.

| | |
|---|---|
| **Azure AI Foundry** | a deployment you have already provisioned. API key, or Microsoft Entra — app registration, managed identity or AKS workload identity, for a resource with local authentication switched off |
| **OpenRouter** | one key, billed per token, reaching every model in the picker |
| **An OpenAI-compatible endpoint** | anything speaking that API at a URL you control: a local Ollama or vLLM, a gateway of your own, an APIM front end, a Codex bridge |
| **Databricks Model Serving** | a Foundation Model API or external model endpoint in a Databricks workspace, behind AI Gateway. The app's own service principal, or a personal access token from a laptop |

**"Saved" is not the same claim as "reachable."** An expired key, a bridge on
another machine and a renamed deployment all look identical until something asks,
so the setup journey ends by making one real call for a single token, and that —
not a filled-in form — is what counts as configured.

### The variables

Everything here is optional. An install configured entirely through `/setup`
needs none of it.

| | |
|---|---|
| `POLICY_PORT`, `POLICY_HOST` | where it listens. Loopback by default, deliberately |
| `POLICY_HOSTNAME` | the public name, if it has one. Used to refuse a citation that points back at this service |
| `POLICY_DATA_DIR` | the database |
| `POLICY_SEAL_KEY_DIR` | the settings key and the per-run sealing keys. **See Backing it up** |
| `POLICY_ADMIN_PASSWORD` | pins the admin password and is the recovery path if it is lost |
| `POLICY_SETUP_TOKEN` | required to claim an install that is not bound to loopback |
| `POLICY_ACCESS` | `open` or `password` — who may read the assessments |
| `POLICY_READER_PASSWORD` | the reader password, when `POLICY_ACCESS=password` |
| `POLICY_READ_ONLY` | `1` makes every mutation a 403. Existing assessments still open and export |
| `POLICY_PROVIDER`, `POLICY_PROVIDERS` | pin the active service; narrow the list this build offers |
| `POLICY_MODELS`, `POLICY_RESEARCH_MODEL` | replace the model menu; set the default model |
| `POLICY_SEARCH` | `auto`, `tavily`, `grounded` or `none` |
| `TAVILY_API_KEY` | a search service for the research stage |
| `POLICY_PRODUCER` | what an offline pack says produced it |
| `POLICY_OWNER_EMAIL` | assessments are scoped to an owner because the column is `NOT NULL` |
| `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`, `NO_PROXY` | see **Deploying somewhere restricted** |

Per provider, for a deployment that sets them in a file rather than typing them:

| | |
|---|---|
| OpenRouter | `OPENROUTER_API_KEY` |
| Azure, all modes | `AZURE_FOUNDRY_ENDPOINT`, `AZURE_FOUNDRY_DEPLOYMENT`, `AZURE_FOUNDRY_API_VERSION`, `AZURE_AUTH_MODE` |
| Azure, API key | `AZURE_FOUNDRY_KEY` |
| Azure, Entra | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_FEDERATED_TOKEN_FILE`, `AZURE_AUTHORITY_HOST` |
| OpenAI-compatible | `CODEX_BASE_URL`, `CODEX_MODEL`, `CODEX_API_KEY` |
| Databricks | `DATABRICKS_HOST`, `POLICY_DATABRICKS_ENDPOINT`, `POLICY_DATABRICKS_AUTH` (`service-principal` or `token`), `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET`, `DATABRICKS_TOKEN` |

A `.env` beside the application is read at startup by both the server and the
command line. Copy `.env.example` if you want one.

### Who can reach it

Two passwords, and they are deliberately different.

The **admin password** opens `/setup` and `/admin`, which is where the model
credentials live. On a fresh install the service accepts `admin` / `admin` **once**,
and the only request that credential is accepted on is the one that replaces it —
no session exists until a real password has been written. Off loopback it is
refused entirely unless you also set `POLICY_SETUP_TOKEN` and present it, so a
service reachable from outside cannot be claimed by whoever finds it first.

The **reader password** (`POLICY_ACCESS=password`) closes everything else. Someone
who can read an assessment should not thereby hold the key to your model
credentials, which is why it is a separate password and a separate cookie. The
default is `open`, so nothing changes for an existing install until you decide.

**Do not gate this on a source address.** Behind a tunnel or a reverse proxy every
request arrives from `127.0.0.1`, so "local connections only" is a gate that passes
for the entire internet. Nothing in the application does this and nothing should.

## Deploying somewhere restricted

`deploy/` has a Dockerfile, a systemd unit and an nginx sample. `npm run doctor`
answers "is it reading my configuration" before an eighteen-stage run answers it
the slow way; `npm run doctor -- --reach` also tries the network, through the
proxy the service itself would use.

### What it needs to reach

At runtime, HTTPS on 443, and only the service you actually configure:

| | |
|---|---|
| your Azure resource endpoint | if you use Azure |
| `login.microsoftonline.com` | Azure with Entra app registration or workload identity only |
| `openrouter.ai` | if you use OpenRouter |
| `api.tavily.com` | only if you configure Tavily for the research stage |

And explicitly, so a security review does not have to take it on trust: **no
telemetry, no update check, no analytics, no content delivery network and no web
font.** Everything the page needs ships with it. Nothing is sent anywhere except
the model service you configure and the search service if you configure one.

At install time it also needs `registry.npmjs.org`. If that is not reachable from
the target, build the image or the `node_modules` tree somewhere that can reach it
and carry the result across — the Dockerfile does exactly this in two stages.

### Through a proxy

Set `HTTPS_PROXY` and `NO_PROXY` and the service uses them, for every outbound
call. Set `NO_PROXY` to include `127.0.0.1,localhost` if anything is configured on
loopback: a bridge sent to a corporate proxy is a bridge that never answers, and
the error reads as "unreachable" either way.

For a TLS-inspecting middlebox, point `NODE_EXTRA_CA_CERTS` at the inspection CA.
Node reads it before any of this code runs and says nothing if the path is wrong,
so the first symptom is every handshake failing — `npm run doctor` checks it is
readable.

## Deploying to Databricks Apps

This runs the service as a [Databricks App](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/),
deployed with a [bundle](https://docs.databricks.com/aws/en/dev-tools/bundles/)
(`databricks.yml`). One deploy sets up everything:

| | |
|---|---|
| **The app** | built on your machine and uploaded ready to run |
| **A Lakebase database** | [Lakebase](https://docs.databricks.com/aws/en/oltp/) Postgres, where the assessments are kept. Created on the first deploy |
| **A model endpoint** | a [Model Serving](https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/) chat endpoint, called as the app's own service principal. No API key anywhere |
| **Two secrets** | the `/admin` password and the settings encryption key, generated for you |

### Before you start

You need:

- **The Databricks CLI**, v1.17 or newer. [Install it](https://docs.databricks.com/aws/en/dev-tools/cli/install).
- **Node 22.23.2 or newer** on your machine (`node --version`). The app is built
  here, not on the platform.
- **In the workspace:** Databricks Apps, Lakebase, and a chat endpoint you can
  query. Check with `databricks serving-endpoints list -p <profile>`.
- **Permission to create** an app, a Lakebase project and a secret scope.

### Deploy it, step by step

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

### After a code change

Repeat steps 4 and 5:

```bash
databricks bundle deploy -t dev -p <profile>
databricks bundle run policy_red_team -t dev -p <profile>
```

`deploy` only uploads. **`run` restarts the app onto the new code.** A run in
progress loses the model call it was making (still billed) and then carries on
from its stage, so avoid redeploying during a run that matters.

### Another workspace

Log in to it with a new profile (step 1) and follow the same steps with that
profile. To pin a workspace or change a setting for it, add a target to
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

### What you can change

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

### What it costs

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
- **Put limits on the endpoint.** Its [AI Gateway](https://docs.databricks.com/aws/en/ai-gateway/)
  settings in the Serving UI give rate limits, usage tracking and inference
  tables. Worth doing before sharing the app: a single run can make hundreds of
  calls.
- **Cancel runs you do not need** from the assessment page. A cancelled run
  stops spending straight away.

### Running it

| | |
|---|---|
| Status and URL | `databricks apps get policy-red-team` |
| Logs | `databricks apps logs policy-red-team --follow`. Needs an OAuth profile, not a personal access token |
| Where the data is | Lakebase project `policy-red-team`, database `databricks_postgres`, schema `policy_red_team` |
| Backups | Lakebase keeps branch history (seven days by default). See [Lakebase projects](https://docs.databricks.com/aws/en/oltp/projects/) |
| Removing it | `databricks bundle destroy -t dev` removes the app. The Lakebase project is marked `prevent_destroy` and the secret scope is outside the bundle, so both stay until deleted by hand |

### When something goes wrong

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

### How it differs from a local install

| | |
|---|---|
| **The database is Lakebase** | An app's filesystem does not survive a restart. `POLICY_DATABASE=lakebase` switches `src/lib/db` from PGlite to a Lakebase pool, whose connection and OAuth password come from the app's `postgres` resource. The tables live in their own schema, `POLICY_PG_SCHEMA`, and the migration runner points upstream's hard-coded `"public".` references at it |
| **Models are Model Serving** | The `databricks` provider calls `<workspace>/serving-endpoints` with the app's service principal token, refreshed before it expires |
| **The workspace sign-in is the gate** | Every request has already passed the Databricks login, and `CAN_USE` on the app decides who that is. So `POLICY_ACCESS=open`. `/admin` keeps its own password |
| **Nothing is installed on the platform** | `npm run stage:app` builds the client and one minified server bundle, with every dependency inside it, into `.app/`, with a `package.json` that lists none. The bundle is 5.6MB, under the platform's 10MB-per-file limit. It cannot carry PGlite's WebAssembly, which is why the staged build is Lakebase only |

### How Model Serving differs

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

### Not yet supported on Apps

- **Sealed runs.** Their keys are files on local disk, and an app's disk is
  wiped on restart. Leave sealing off until the keys have somewhere durable to
  live, such as a Unity Catalog volume.
- **Finishing a stage on shutdown.** The platform gives a stopping app fifteen
  seconds, not the minutes a stage can take. After ten, the app hands its
  claimed stages back to the queue so the next instance picks them up at once;
  the call in flight is lost and billed, and the stage resumes.

### Why the secret scope is not a bundle resource

A bundle that manages a secret scope's permissions replaces the whole access
list. On the first attempt that removed the READ access the app's own
`secret` resources had granted it, so the next restart would have come up
without its secrets. Naming the app's principal in the bundle's list does not
work either, because the reference is not resolved there. So `init_secrets`
creates the scope, and the app's resource declarations grant the only access
it needs. See [secret management](https://docs.databricks.com/aws/en/security/secrets/).

## Backing it up

Three things, with three different rules. Getting the second one wrong is quiet
and getting the third one wrong is not recoverable.

| | |
|---|---|
| **The database** (`POLICY_DATA_DIR`) | back it up normally. It holds the assessments |
| **`settings.key`** (in `POLICY_SEAL_KEY_DIR`) | back it up **separately from the database**. It decrypts every stored credential. Lose it and the service starts fine and reports every credential as unset, because a row that will not decrypt is dropped rather than thrown on |
| **The sealing keys** (same directory) | **a lost key is a shredded run, by design.** Backing them up is a decision to weaken that guarantee, not an oversight to correct. Decide deliberately |

The settings key and the database are kept apart on purpose: a database copy, a
nightly dump or a snapshot beside it carries ciphertext and no key.

## Upgrading

Migrations run at boot and are forward-only. `git pull && npm install && npm run build`,
then restart. There is no down migration and no rollback path for the schema; take
a copy of the data directory first if that matters to you.

## Commands

```
npm start              build everything and serve on 127.0.0.1:5290
npm run dev            the client alone, with hot reload
npm run doctor         what this install resolved, and optionally --reach
npm run cli            the command line: assess, list, report, migrate
npm run stage:app      build the Databricks App into .app/ (bundle deploy runs it)
npm run test:all       every gate below, in order
```

| | |
|---|---|
| `npm test` | 1,029 unit tests, no database |
| `npm run test:integration` | the pipeline against a throwaway database, provider mocked |
| `npm run claim` | the shipped credential cannot survive, and both gates gate |
| `npm run a11y` | axe on every route **and** the licensing assertions |
| `npm run walk` | a browser from submit to report, against the fixture server |
| `npm run offline` | the pack, opened from `file://` with every request blocked |

Three of those drive a real browser and need one: `npx playwright install chromium`.
The running service needs none of it.

## How it is built

- **Node 22 and `node:http`** — no web framework
- **React 19, TypeScript, Vite** — a single-page client, no meta-framework
- **[GOV.UK Design System](https://design-system.service.gov.uk/)** — see below
- **PGlite** — real PostgreSQL compiled to WebAssembly, in-process, one directory

### If you fork this

The pipeline — eighteen stages, the contracts, the validation and repair loop, the
budget fitter — is copied from a private SvelteKit application, about 14,000 lines
of it plus its test suite. `docs/upstream.json` names every copied file and
records every deliberate divergence; `npm run sync:check` reports drift.

**That machinery is for the author and it does not work without the private
repository beside this one.** You can ignore it. If you change a file
`docs/upstream.json` lists, `sync:check` will tell you so — it applies each
recorded divergence and compares byte for byte — and you can simply not run
`npm run sync`, which is the thing that would overwrite your change.

`deploy/estate/` is the author's own deployment and is no use to anybody else. It
is kept, labelled, rather than deleted, because it is the working record of how
this is actually run.

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

## Documentation

`docs/` carries the plan and a record of each phase — what was built, what broke,
and the decisions taken with their reasoning. `plan.md` is the original build
plan; `phase-18-plan.md` is the most recent, and covers standing this up
independently. `AGENTS.md` is the short list of things that will cost you an hour
if nobody says them.

## Licence

MIT. See `LICENCE`.

GOV.UK Frontend is used under the MIT Licence. Its crown, coat of arms and
typeface are not used.
