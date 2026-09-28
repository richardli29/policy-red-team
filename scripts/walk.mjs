/**
 * The journey, driven in a browser: submit a paper, watch it run, read the report.
 *
 * This is phase 4's gate. It runs against `dist/server-fixture.js`, which is
 * compiled with no path to a model provider at all — so the walk exercises the
 * real HTTP layer, the real queue, the real store and the real React, and cannot
 * spend a penny doing it.
 *
 * axe runs on every page it lands on, including the two that only exist while a
 * run is in flight. Those are the pages `npm run a11y` cannot reach on its own,
 * because they need an assessment to exist.
 *
 *   node scripts/walk.mjs
 */
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { spawn } from 'node:child_process';
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5299;
const failures = [];
const note = (m) => console.log(`  ${m}`);

// A throwaway database, the same promise the integration suite keeps: a walk
// that creates and cancels assessments must never be able to touch a real one.
const dataRoot = await mkdtemp(path.join(tmpdir(), 'policy-walk-'));
const ADMIN_PASSWORD = 'walk-admin-password';

const server = spawn(process.execPath, [path.join(ROOT, 'dist', 'server-fixture.js')], {
  env: {
    ...process.env,
    POLICY_PORT: String(PORT),
    // Never Lakebase, whatever the shell says: this walk purges.
    POLICY_DATABASE: '',
    POLICY_DATA_DIR: path.join(dataRoot, 'db'),
    POLICY_SEAL_KEY_DIR: path.join(dataRoot, 'keys'),
    // The panel is CLOSED without one, which is itself a thing worth testing —
    // but the walk needs it open to test the rest, so it sets its own.
    POLICY_ADMIN_PASSWORD: ADMIN_PASSWORD,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`  server: ${d}`));

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start')), 30000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('Policy Red Team on')) { clearTimeout(timer); resolve(); }
  });
});
note(`server up on ${PORT}`);

const axeSource = await readFile(path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (err) => failures.push(`page error: ${err.message}`));

async function audit(label) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    });
    // THE SELECTOR, NOT JUST THE COUNT. A note reading "moderate landmark-unique
    // (1)" is a note nobody can act on: it says something is wrong once,
    // somewhere, on a page with eighteen sections. Carrying the first few
    // targets turns it into a thing that can be looked at.
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
      where: v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | '),
    }));
  });
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  for (const v of bad) failures.push(`${label}: axe ${v.impact} ${v.id} — ${v.help} (${v.nodes}) ${v.where}`);
  for (const v of violations.filter((v) => !bad.includes(v))) console.log(`  note  ${label}: ${v.impact} ${v.id} (${v.nodes}) ${v.where}`);
  return bad.length === 0;
}

try {
  // 1 — the landing page, with nothing on it yet
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  if (!(await page.getByRole('heading', { name: 'Policy Red Team' }).isVisible())) failures.push('landing: no heading');
  await audit('/');
  note('landing');

  // 2 — the form, and its error summary before anything is filled in
  // GOV.UK renders a button-shaped anchor with role="button", not link.
  await page.getByRole('button', { name: 'Assess a paper' }).click();
  await page.waitForURL('**/new');
  await page.getByRole('button', { name: 'Start the assessment' }).click();
  await page.getByRole('alert').waitFor({ timeout: 5000 });
  const summaryText = await page.getByRole('alert').innerText();
  for (const expected of ['Enter a title', 'Select the paper']) {
    if (!summaryText.includes(expected)) failures.push(`/new: error summary missing "${expected}"`);
  }
  // The summary must take focus, or a screen-reader user never hears it.
  const focusedClass = await page.evaluate(() => document.activeElement?.className ?? '');
  if (!focusedClass.includes('govuk-error-summary')) failures.push('/new: the error summary did not take focus');
  await audit('/new (errors)');
  note('form validates, and the summary takes focus');

  // 3 — submit a real paper
  await page.getByLabel('What is this paper called?', { exact: true }).fill('Walk fixture paper');
  // Exact: getByLabel is a substring match, and 'The paper' also matches
  // 'Anything the paper does not say'.
  await page.getByLabel('The paper', { exact: true }).setInputFiles(path.join(ROOT, 'tests', 'fixtures', 'policy-analysis', 'policy.txt'));
  await page.getByLabel('Jurisdiction', { exact: true }).fill('England');
  await page.getByRole('button', { name: 'Start the assessment' }).click();
  await page.waitForURL('**/assessments/**', { timeout: 20000 });
  note('submitted');

  // 4 — the report, once the run finishes. The page follows its own progress
  // over the event stream, so this is waiting for the UI to update itself.
  await page.getByRole('heading', { name: 'What it found' }).waitFor({ timeout: 120000 });
  const id = page.url().split('/').pop();

  /*
   * THE REPORT IS FOUR MOVES NOW, so a section being absent from the page is
   * only a failure if its own tab is open. Every move is visited, because a
   * section silently assigned to the wrong one still renders — just never where
   * the reader looking for it will be.
   */
  const MOVES = [
    ['verdict', 'What it found'],
    ['causality', 'How they connect'],
    ['threats', 'Ways to beat it'],
    ['actors', 'Who is involved'],
    ['provenance', 'How this was produced'],
  ];
  for (const [tab, heading] of MOVES) {
    await page.getByRole('tab', { name: new RegExp(tab, 'i') }).click();
    const visible = await page.locator('#main-content').innerText();
    if (!visible.includes(heading)) failures.push(`report: "${heading}" is not in the ${tab} move`);
  }

  await page.getByRole('tab', { name: /provenance|discarded/i }).click();
  const provenance = await page.locator('#main-content').innerText();
  if (!/18 of 18 completed/.test(provenance)) failures.push('report: does not say all eighteen stages completed');

  /*
   * THE SELECTION HAS TO SURVIVE A TAB CHANGE, which is the one thing here that
   * breaks without throwing: the view simply shows a narrower set, and a reader
   * comparing two moves draws a conclusion from a list they did not know was
   * filtered.
   */
  await page.getByRole('tab', { name: /verdict/i }).click();
  // The four exposure boxes are one segmented bar now: `.prt-profile` is gone
  // from the markup and, since the dead-rule sweep, from the stylesheet too.
  // and the segments are the control. The walk went green on a selector that
  // matched nothing, reporting "no exposure band to select" rather than passing
  // — which is the right failure, and is why this is a walk and not a unit test.
  const band = page.locator('.prt-stack__seg').first();
  if (await band.count()) {
    await band.click();
    const banner = page.locator('.prt-selection');
    const stated = await banner.innerText();
    if (!/Showing/.test(stated)) failures.push('report: selecting a band says nothing above the views');

    await page.getByRole('tab', { name: /threats/i }).click();
    const afterTab = await page.locator('.prt-selection').innerText();
    if (afterTab !== stated) failures.push('report: the selection did not survive a tab change');

    // And it is clearable from a view other than the one that set it.
    await page.getByRole('button', { name: /Clear the selection/i }).click();
    const cleared = await page.locator('.prt-selection').innerText();
    if (!/Select a band/.test(cleared)) failures.push('report: the selection could not be cleared from another move');
  } else {
    failures.push('report: no exposure band to select');
  }

  /*
   * EVERY MOVE IS AUDITED, not just the one that happens to be open.
   *
   * `hidden` content is invisible to axe, so a single run with Verdict showing
   * audited a fifth of the report — the weighting sliders, the mechanism bars
   * and the provenance table would all have shipped unchecked. Before the moves
   * this was one visible cascade and one run covered it.
   */
  for (const [tab] of MOVES) {
    await page.getByRole('tab', { name: new RegExp(tab, 'i') }).click();
    await audit(`/assessments/:id (report — ${tab})`);
  }
  await page.getByRole('tab', { name: /verdict/i }).click();
  note(`report rendered for ${id}, four moves with a carried selection`);

  // 5 — the diagram and its table are both reachable, which the accessibility
  // statement promises and which nothing else checks.
  // Each toggle names its own figure — three of them on this page now, and
  // three buttons all announcing "Table" would tell a screen-reader user
  // nothing about which table.
  const tableToggle = page.getByRole('button', { name: 'Table of ease against impact' });
  if (await tableToggle.count()) {
    await tableToggle.click();
    await page.getByRole('table', { name: /ease and impact/i }).waitFor({ timeout: 5000 }).catch(() => {
      failures.push('report: the exposure plot has no table view');
    });
    // The pressed view must be visible and not merely announced: two identical
    // grey buttons over a chart leave a sighted reader no way to know which one
    // they are looking at.
    const pressed = await tableToggle.evaluate((el) => ({
      pressed: el.getAttribute('aria-pressed'),
      secondary: el.className.includes('govuk-button--secondary'),
    }));
    if (pressed.pressed !== 'true' || pressed.secondary) {
      failures.push('report: the selected view is not marked pressed, or does not look it');
    }
    await audit('/assessments/:id (table view)');
    note('diagram and table both render, and the pressed one looks pressed');
  }

  // 5b — THE RELATIONSHIP GRAPH. Present only when the paper states
  // relationships; the fixture states one, which is enough to prove the section
  // renders, counts and links.
  // The graph lives in Causality now; open that move before looking for it.
  await page.getByRole('tab', { name: /causality/i }).click();
  const connect = page.getByRole('heading', { name: 'How they connect' });
  if (await connect.count()) {
    await connect.scrollIntoViewIfNeeded();
    const netText = await page.locator('section[aria-labelledby="network"]').innerText();
    for (const expected of ['Where the relationships run', 'What kind of relationship', 'Bodies against bodies', 'What the connections show']) {
      if (!netText.includes(expected)) failures.push(`network: missing "${expected}"`);
    }
    // Either branch is a real answer, and the fixture takes the second: its one
    // stated relationship runs from a body to machinery, so there is no
    // body-to-body mesh — which is the shape of a real policy paper too, and the
    // reason the section says so in words rather than drawing an empty grid.
    if (!/(\d+ of the \d+ stated relationships run between two bodies|no relationship between two bodies at all)/.test(netText)) {
      failures.push('network: does not say how the bodies relate to each other');
    }
    await page.getByRole('button', { name: 'Table of where the relationships run' }).click();
    await page.getByRole('table', { name: /kind of thing at each end/i }).waitFor({ timeout: 5000 }).catch(() => {
      failures.push('network: the shape figure has no table view');
    });
    await audit('/assessments/:id (relationships)');
    note('the relationship section renders, with its tables');
  } else {
    failures.push('report: no "How they connect" section at all');
  }

  // 5c — THE STRESS TEST: the one thing on the page you RUN rather than read.
  //
  // It simulates, so a gate that only checks it rendered has checked nothing.
  // This pulls a lever and asserts the page changed, that the two directions
  // stayed opposite, and that axe is clean on the result — which is a different
  // DOM from the one at rest.
  // The stress lab is the one thing you RUN rather than read, so it sits with
  // the plays in Threats.
  await page.getByRole('tab', { name: /threats/i }).click();
  const stress = page.getByRole('heading', { name: 'What if we are wrong' });
  if (await stress.count()) {
    await stress.scrollIntoViewIfNeeded();
    const panel = page.locator('section[aria-labelledby="stress"]');
    const atRest = await panel.innerText();
    if (!atRest.includes('Nothing failed yet')) failures.push('stress: does not say it is waiting for a lever');

    const lever = panel.locator('input[type=checkbox]').first();
    if (!(await lever.count())) {
      failures.push('stress: rendered with no levers at all');
    } else {
      // Every lever must be reachable and labelled, or the panel is unusable
      // from a keyboard — which is the whole risk of a bespoke control and the
      // reason this uses GOV.UK's checkboxes.
      const labelled = await panel.evaluate((el) => [...el.querySelectorAll('input[type=checkbox]')]
        .every((i) => !!el.querySelector(`label[for="${i.id}"]`)));
      if (!labelled) failures.push('stress: a lever has no label pointing at it');

      await lever.check();
      await page.waitForTimeout(200);
      const pulled = await panel.innerText();
      if (pulled === atRest) failures.push('stress: pulling a lever changed nothing on the page');
      if (!/\d+ of \d+ conclusions and results lose their footing|No conclusion loses its footing/.test(pulled)) {
        failures.push('stress: does not say how much lost its footing');
      }
      // THE TWO DIRECTIONS MUST NEVER BE COLLAPSED, and this asserts it against
      // the DOM rather than against two adjacent string literals — which is what
      // it did before, and which could not fail. A disarmed play is good news
      // for the policy; a conclusion that lost its footing is not, and a review
      // found one being printed in red under the other's heading.
      const mixed = await panel.evaluate(() => {
        const bad = [];
        for (const section of document.querySelectorAll('section[aria-labelledby^="stress-"]')) {
          const id = section.getAttribute('aria-labelledby');
          const tags = [...section.querySelectorAll('.govuk-tag')].map((t) => t.textContent.trim());
          const good = id === 'stress-disarmed' || id === 'stress-eased';
          if (!good && tags.some((t) => /Taken off the table|No longer applies/.test(t))) bad.push(`${id}: ${tags.join(', ')}`);
          if (id === 'stress-disarmed' && tags.some((t) => /Nothing left supporting it|Partly undercut/.test(t))) {
            bad.push(`${id}: ${tags.join(', ')}`);
          }
        }
        return bad;
      });
      for (const bad of mixed) failures.push(`stress: the two directions are mixed — ${bad}`);
      // And the figure has to be about what FELL, never about everything that moved.
      if (/conclusions and results move/.test(pulled)) {
        failures.push('stress: the headline counts both directions as one figure');
      }
      if (!/structural check(s)? (is|are) untouched/.test(pulled)) {
        failures.push('stress: does not say what cannot move');
      }
      await audit('/assessments/:id (stress test, pulled)');

      // THE SHOW-ALL PATH, where a ticked lever used to vanish. Expanding and
      // collapsing the rail must never silently drop what the reader chose, nor
      // leave a results panel driven by a lever with no box on screen.
      const showAll = panel.getByRole('button', { name: /most rested on/ });
      if (await showAll.count()) {
        await showAll.click();
        const expanded = panel.locator('input[type=checkbox]');
        const last = expanded.nth((await expanded.count()) - 1);
        const lastId = await last.getAttribute('id');
        await last.check();
        await showAll.click();
        await page.waitForTimeout(200);
        const still = panel.locator(`input[type=checkbox]#${lastId}`);
        if (!(await still.count())) {
          failures.push('stress: collapsing the rail hid a ticked lever, leaving no way to untick it');
        } else if (!(await still.isChecked())) {
          failures.push('stress: collapsing the rail silently unticked a lever');
        }
        await still.uncheck().catch(() => {});
        note('a ticked lever survives the rail collapsing');
      }

      await lever.uncheck();
      await page.waitForTimeout(200);
      if (!(await panel.innerText()).includes('Nothing failed yet')) {
        failures.push('stress: unticking the lever did not put it back');
      }
      note('the stress test runs, and both directions stay opposite');
    }
  } else {
    failures.push('report: no "What if we are wrong" section at all');
  }

  // 5d — THE COPY YOU SEND SOMEONE, and what is not in it.
  //
  // There is no share LINK: every owner route here is unauthenticated by
  // design, so a URL that worked for a recipient would also hand them the whole
  // paper two requests later. The redacted copy leaves as a FILE, and these are
  // the assertions that matter — not that the page rendered, but that three
  // kinds of thing are absent from what a recipient receives.
  // Sharing and the export are actions on the whole report, so they sit in
  // Verdict — and the walk has been in Threats since the stress test.
  await page.getByRole('tab', { name: /verdict/i }).click();
  /*
   * ONE SECTION, NOT TWO. "Take it away" and "Send it to someone" were two
   * headings over one subject — every download in the first, and in the second
   * an argument about links plus the redacted copy. They are now one `take`
   * section holding a download grid and that argument.
   *
   * SO THE ASSERTION MOVED RATHER THAN RELAXED. The section now legitimately
   * offers the owner's own unredacted exports beside the shared one, so "no
   * download here that is not redacted" is no longer the invariant. What still
   * has to be true is that the redacted copy is offered, that the page says why
   * there is no link, and — the assertion that actually protects a recipient —
   * that the shared pack's payload withholds the three kinds, which is checked
   * against the real bytes below.
   */
  await page.getByRole('heading', { name: 'Take it away' }).scrollIntoViewIfNeeded();
  const panelText = await page.locator('section[aria-labelledby="take"]').innerText();
  if (!/no link to send/i.test(panelText)) failures.push('take: does not say why there is no link');
  if (!(await page.locator('section[aria-labelledby="take"] a[href*="scope=shared"]').count())) {
    failures.push('take: does not offer the redacted copy');
  }

  const owned = await page.evaluate(async (a) => (await fetch(`/api/policy-analysis/${a}`)).json(), id);
  const sharedZip = Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/api/policy-analysis/${id}/export?format=bundle&scope=shared`)).arrayBuffer());
  const zip = await JSZip.loadAsync(sharedZip);
  const sharedHtml = await zip.file(Object.keys(zip.files).find((f) => f.endsWith('index.html'))).async('string');
  const island = /<script type="application\/json" id="[^"]*">([\s\S]*?)<\/script>/.exec(sharedHtml);
  const payload = island ? JSON.parse(island[1]) : null;
  if (!payload) {
    failures.push('send: the shared pack carries no payload to check');
  } else {
    // The three kinds a recipient must never receive. `persona_link` is the one
    // upstream does not withhold — its data carries the standing dossier drawn
    // from the owner's OTHER assessments — and is a recorded divergence.
    for (const kind of ['passage', 'cross_policy', 'persona_link']) {
      if (payload.artefacts.some((a) => a.kind === kind)) failures.push(`send: the shared pack carries ${kind} artefacts`);
    }
    if (!payload.withheld?.length) failures.push('send: the shared pack does not say anything was withheld');
    if (payload.documentSha256 !== null) failures.push('send: the shared pack carries the document digest, which is a confirmation oracle');
    // And the paper's own words are not in what the file carries.
    //
    // Searched in the PARSED payload rather than the raw HTML: the payload is a
    // JSON island, so a newline inside a passage arrives as the two characters
    // `\` `n` and a substring search over the markup silently matches nothing.
    // That made this assertion vacuous until the control below caught it.
    const flat = (v) => v.replace(/\s+/g, ' ');
    const words = (p) => flat(p.artefacts.map((a) => `${a.statement} ${a.sourceQuote ?? ''}`).join(' '));
    const passage = owned.artefacts.find((a) => a.kind === 'passage' && a.statement.length > 120);
    const needle = passage ? flat(passage.statement).slice(40, 110) : null;
    if (needle && words(payload).includes(needle)) {
      failures.push('send: a span of the paper survived into the shared pack');
    }

    // THE OWNER'S OWN PACK IS THE CONTROL. Without it the check above passes
    // just as happily against a pack that carries nothing at all — and it did.
    const ownZip = await JSZip.loadAsync(Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/api/policy-analysis/${id}/export?format=bundle`)).arrayBuffer()));
    const ownHtml = await ownZip.file(Object.keys(ownZip.files).find((f) => f.endsWith('index.html'))).async('string');
    const ownIsland = /<script type="application\/json" id="[^"]*">([\s\S]*?)<\/script>/.exec(ownHtml);
    const ownPayload = ownIsland ? JSON.parse(ownIsland[1]) : { artefacts: [] };
    for (const kind of ['passage', 'persona_link']) {
      if (!ownPayload.artefacts.some((a) => a.kind === kind)) {
        failures.push(`send: the OWNER pack has no ${kind} either, so the redaction check proves nothing`);
      }
    }
    if (needle && !words(ownPayload).includes(needle)) {
      failures.push('send: the OWNER pack is missing the paper, so the redaction check proves nothing');
    }
    note(`the copy you send withholds ${payload.withheld.map((w) => `${w.count} ${w.kind}`).join(', ')}`);
  }

  // 5e — SOMETHING READ AFTER THE REPORT WAS WRITTEN, and the report written again.
  //
  // The whole point is that NOTHING IS RE-RUN: a pass owns its own block of
  // ordinals and appends, so the original report stays exactly as it was. What
  // this asserts is that the pass ran, that it reached a verdict on an existing
  // conclusion, and that the banner above the verdict says so — a reader who
  // meets the conclusion first has already formed a view of a report that has
  // been overtaken.
  await page.getByRole('tab', { name: /verdict/i }).click();
  await page.getByRole('heading', { name: 'What came after this was written' }).scrollIntoViewIfNeeded();
  const material = path.join(dataRoot, 'walk-rebuttal.txt');
  await writeFile(material, 'A rebuttal. The Council disputes that it has the capacity assumed, and says the funding line is not committed beyond one year.');
  // The form is behind a disclosure now: 1,300px of radios and pickers at the
  // foot of every report was a sixth of the page, permanently open, for a thing
  // done rarely. Opening it is part of the journey and so is walked.
  await page.locator('summary', { hasText: 'Add something to it' }).click();
  await page.getByLabel('A critique or rebuttal').check();
  await page.getByLabel('The document', { exact: true }).setInputFiles(material);
  await page.getByLabel('Anything you want the reading to know').fill('Sent by the Council.');
  await page.getByRole('button', { name: 'Read it against this assessment' }).click();

  /*
   * WAIT ON THE STATE, NOT ON A HEADING. The report is still on screen for the
   * moment between the click and the status change, so waiting for "What it
   * found" matched the page that was already there and every assertion below
   * then read a report with no addendum in it. Polling the API for the thing
   * that must become true is the only version of this that cannot race.
   */
  await page.waitForFunction(
    async (a) => {
      const data = await (await fetch(`/api/policy-analysis/${a}`)).json();
      return data.passes.some((p) => p.kind === 'addendum' && /completed/.test(p.status));
    },
    id,
    { timeout: 180000, polling: 1000 },
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /verdict/i }).click();
  await page.getByRole('heading', { name: 'What came after this was written' }).waitFor({ timeout: 60000 });

  const afterText = await page.locator('section[aria-labelledby="after"]').innerText();
  if (process.env.WALK_DEBUG) console.log('--- AFTER SECTION ---\n' + afterText.slice(0, 900) + '\n---');
  if (!/A critique or rebuttal/.test(afterText)) failures.push('material: the pass does not say what was attached');
  if (!/passage read|passages read/.test(afterText)) failures.push('material: the pass does not say it read anything');
  if (!/Sent by the Council/.test(afterText)) failures.push('material: the reader\'s own note was dropped');
  // A verdict on an existing conclusion is the thing a pass exists to produce.
  const verdicts = await page.locator('section[aria-labelledby="after"] .govuk-tag').allInnerTexts();
  if (!verdicts.length) failures.push('material: the pass reached no verdict on anything');
  // And the banner, which must sit ABOVE the verdict rather than in the section.
  const banners = await page.locator('#main-content .govuk-warning-text').allInnerTexts();
  if (!banners.some((b) => /overtaken in part/.test(b))) {
    failures.push('material: nothing above the verdict says the report has been overtaken');
  }
  await audit('/assessments/:id (with an addendum)');
  note(`material read, ${verdicts.length} ${verdicts.length === 1 ? 'verdict' : 'verdicts'} reached`);

  // Writing it again, which the store refuses without a completed addendum —
  // so this could only ever run after the step above.
  // Behind its own disclosure, for the same reason the attach form is: a
  // restatement is the most expensive call in the tool and the rarest thing a
  // reader does with a report.
  await page.locator('summary', { hasText: 'Write the report again' }).click();
  const rewrite = page.getByRole('button', { name: 'Write it again' });
  if (!(await rewrite.count())) {
    failures.push('restate: not offered even with a completed addendum');
  } else {
    await rewrite.click();
    await page.waitForFunction(
      async (a) => {
        const data = await (await fetch(`/api/policy-analysis/${a}`)).json();
        return data.passes.some((p) => p.kind === 'restatement' && /completed/.test(p.status));
      },
      id,
      { timeout: 180000, polling: 1000 },
    );
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'What it found' }).waitFor({ timeout: 60000 });
    const detail = await page.evaluate(async (a) => (await fetch(`/api/policy-analysis/${a}`)).json(), id);
    if (!detail.passes.some((p) => p.kind === 'restatement' && /completed/.test(p.status))) {
      failures.push('restate: no completed restatement was recorded');
    }
    // NOTHING WAS RE-RUN. The original eighteen stages keep their ordinals and
    // the passes own their own block, so the report that was superseded is
    // still stored — which is the property the whole design turns on.
    if (detail.stages.filter((st) => st.ordinal < 100).length !== 18) {
      failures.push('restate: the original stages were disturbed');
    }
    note('the report was written again, and the original stages were left alone');
  }

  // 6 — THE DRILL: one artefact, opened out, with its chain back to the paper.
  //
  // Reached by clicking a name in the report, never by typing the URL. A link
  // that renders and does not navigate is the exact failure this step exists to
  // catch, and it is invisible to a type check.
  await page.getByRole('tab', { name: /threats/i }).click();
  // The playbook TABLE is gone — it printed the same forty-seven plays the
  // ranked cards above it already print, in five columns narrow enough to set
  // "compliant" as "compli / ant". The cards are the list now, so the drill is
  // entered from the first card's title, which is the link a reader would use.
  // SCOPED TO THE OPEN PANEL. Play cards appear in Verdict too ("read these
  // three first"), and a page-wide locator resolved to one inside a `hidden`
  // panel — which clicks forever without ever being visible.
  const firstPlay = page.locator('#report-panel-threats .prt-play__title a').first();
  const playName = (await firstPlay.innerText()).trim();
  await firstPlay.click();
  await page.waitForURL('**/artefacts/**', { timeout: 10000 });
  const drillUrl = page.url();
  // WAIT FOR THE HEADING, don't just look for it. The drill fetches the
  // assessment on mount, so the URL changes a beat before the page has anything
  // on it — and reading the DOM in that beat reports an empty page, which is
  // indistinguishable from a broken one.
  await page.getByRole('heading', { level: 1, name: playName }).waitFor({ timeout: 10000 }).catch(() => {
    failures.push(`drill: opened ${page.url()} but its heading never became "${playName}"`);
  });
  // WHAT THE BROWSER USED TO DO FOR FREE. The playbook sits well down a long
  // report, so a client-side navigation that moves neither scroll nor focus
  // lands the reader partway down the new page, below its own heading, with
  // nothing announced. All three are asserted because all three were free until
  // the back link stopped being a document navigation.
  const landing = await page.evaluate(() => ({
    scrollY: window.scrollY,
    focused: document.activeElement?.id ?? null,
    title: document.title,
  }));
  if (landing.scrollY !== 0) failures.push(`drill: landed ${landing.scrollY}px down the page`);
  if (landing.focused !== 'main-content') failures.push(`drill: focus went to "${landing.focused}", not the main landmark`);
  if (!landing.title.startsWith(playName)) failures.push(`drill: the tab still says "${landing.title}"`);

  const drill = await page.locator('#main-content').innerText();
  for (const expected of ['How this would be run', 'Where this stands', 'What it rests on']) {
    if (!drill.includes(expected)) failures.push(`drill: missing section "${expected}"`);
  }
  // The chain is the whole point of the page. Stopping at the assessment's own
  // middle layers would leave a reader unable to argue with a finding, which is
  // the thing the drill is FOR.
  if (!/Followed back \d+ steps?/.test(drill)) failures.push('drill: the chain does not say how far back it went');
  if (!/Back at the paper/.test(drill)) failures.push('drill: the chain never reaches the paper');
  await audit('/assessments/:id/artefacts/:artefactId (a play)');
  note(`drill opens on "${playName}", with its chain`);

  // 7 — follow the chain one hop, then reverse out of it two ways.
  //
  // `__spa` is stamped on the window here and checked after the back link: if
  // either navigation reloaded the document the stamp is gone, which is how a
  // plain <a href> in a single-page app announces itself.
  const here = page.url();
  await page.evaluate(() => { window.__spa = true; });
  await page.locator('#main-content a[href*="/artefacts/"]').first().click();
  await page.waitForFunction((was) => location.href !== was, here, { timeout: 10000 });
  await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 10000 }).catch(() => {
    failures.push('drill: following the chain landed on a page that never rendered a heading');
  });
  await audit('/assessments/:id/artefacts/:artefactId (followed)');

  await page.goBack();
  await page.waitForURL(here, { timeout: 10000 });
  await page.getByRole('heading', { level: 1, name: playName }).waitFor({ timeout: 10000 });
  note('the chain is followable, and the browser back button reverses it');

  /*
   * THE BACK LINK RETURNS TO WHERE THE READER WAS, not to the top of the report.
   *
   * This used to wait for "What it found" — a Verdict section — because the back
   * link always landed on Move 1 with the selection cleared. That was the defect:
   * following a play out of Threats under a mechanism and pressing the one
   * visible way back put the reader on a different move showing everything,
   * while the browser's own Back, which nobody is looking at, was perfect.
   *
   * So the assertion is now the behaviour rather than the symptom: the report
   * renders, and the panel showing is the one the drill was opened from. Read
   * off the URL rather than hard-coded, so it keeps holding if the walk's route
   * through the moves changes.
   */
  await page.locator('.govuk-back-link').click();
  await page.waitForURL((url) => /\/assessments\/[^/]+$/.test(url.pathname), { timeout: 10000 });
  await page.getByRole('tablist').waitFor({ timeout: 15000 }).catch(() => {
    failures.push('drill: the back link did not return to the report');
  });
  /*
   * AND THE URL HAS TO AGREE WITH THE PANEL, which is a second assertion and not
   * a restatement of the first. The move arrives as a query parameter and the
   * component mounts on its default before the reading effect applies it, so the
   * writing effect can strip the parameter on the first commit and put it back
   * on the second. A page that shows Threats under a URL that says Verdict looks
   * right and loses the reader's place on reload — which is the whole defect this
   * carries the position to fix.
   */
  const showing = await page.locator('[role="tab"][aria-selected="true"]').innerText().catch(() => '');
  await page.waitForFunction(() => true, null, { timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(600);
  const cameBack = new URL(page.url()).searchParams.get('move') ?? 'verdict';
  if (!showing.toLowerCase().includes(cameBack)) {
    failures.push(`drill: the back link showed "${showing.replace(/\s+/g, ' ').slice(0, 40)}" and the URL settled on ${cameBack} — a reload would lose the reader's place`);
  }
  if (!(await page.evaluate(() => window.__spa === true))) {
    failures.push('drill: leaving the drill reloaded the whole app rather than routing');
  }
  note(`the back link returns to ${cameBack}, without reloading`);

  // 8 — REFLOW, at the narrowest width WCAG 2.2 asks about.
  //
  // 1.4.10 is about content reflowing to 320 CSS pixels without a second scroll
  // direction, and axe cannot see it: a table that pushes the page sideways is
  // valid markup. Both drill tables did, and so did the report's — the links
  // this change added to the actors and checks columns made cells wider than the
  // phone they have to fit on. `<Table scroll>` is the fix and this is what
  // notices the next one.
  await page.setViewportSize({ width: 320, height: 800 });
  for (const [label, url, ready] of [
    // WAIT FOR THE CONTENT, NOT THE SHELL. `Template` paints an h1 before the
    // detail request returns, so waiting on a level-1 heading measured a page
    // that had not drawn a single table yet — this check has been passing on an
    // empty page. The second wait names something only the loaded report has.
    ['report', `http://127.0.0.1:${PORT}/assessments/${id}`, 'What it found'],
    ['drill', drillUrl, null],
  ]) {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 20000 });
    if (ready) await page.getByRole('heading', { name: ready }).waitFor({ timeout: 30000 });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 0) failures.push(`${label}: at 320px the page scrolls ${wide}px sideways — a table needs <Table scroll>`);
    /*
     * AND AXE, AT THIS WIDTH. Every audit in this file runs at 1280×900, so the
     * rules that only bite on a phone were never asked: `target-size` on the
     * exposure bar's narrowest segment (12px of a 24px floor) and `list` on the
     * tab strip, whose items keep `role="presentation"` after the component tears
     * itself down. Both were sitting on the live report, both serious, and the
     * gate was green because nobody measured at 320.
     */
    await audit(label + ' at 320px');
  }

  /*
   * AND THIS CHECK ONLY WORKS BECAUSE EVERY MOVE IS VISIBLE AT 320px.
   *
   * `Tabs` tears its own semantics down below the framework's tablet breakpoint
   * and stops hiding panels, exactly as `tabs.mjs` does — so at this width the
   * report is one document again and every table is measured. Hide them here and
   * the check silently narrows to whichever move happens to be open, which is
   * what it did for one build of the moves. Asserted rather than assumed.
   */
  await page.goto(`http://127.0.0.1:${PORT}/assessments/${id}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'What it found' }).waitFor({ timeout: 30000 });
  const narrow = await page.locator('#main-content').innerText();
  for (const heading of ['Ways to beat it', 'Who is involved', 'How they connect']) {
    if (!narrow.includes(heading)) {
      failures.push(`report at 320px: "${heading}" is hidden, so the reflow check cannot see its tables`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  note('nothing overflows at 320px');

  // 9 — the history now has a row, and it links back
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  if (!(await page.getByRole('link', { name: 'Walk fixture paper' }).isVisible())) failures.push('landing: the finished assessment is not listed');
  await audit('/ (with a row)');
  note('history lists it');

  // 9b — THE PERSONA LIBRARY, and a dossier opened from it.
  //
  // The library only earns its place on the SECOND paper that names a body, so
  // the walk runs one — without which the page under test is the single case
  // where a dossier adds nothing the assessment did not already say.
  await page.goto(`http://127.0.0.1:${PORT}/new`, { waitUntil: 'networkidle' });
  await page.getByLabel('What is this paper called?', { exact: true }).fill('Walk second paper');
  await page.getByLabel('The paper', { exact: true }).setInputFiles(path.join(ROOT, 'tests', 'fixtures', 'policy-analysis', 'policy.txt'));
  await page.getByRole('button', { name: 'Start the assessment' }).click();
  await page.waitForURL('**/assessments/**', { timeout: 20000 });
  await page.getByRole('heading', { name: 'What it found' }).waitFor({ timeout: 120000 });

  await page.goto(`http://127.0.0.1:${PORT}/personas`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Persona library', level: 1 }).waitFor({ timeout: 20000 });
  const persona = page.locator('#main-content table a').first();
  if (!(await persona.count())) {
    failures.push('personas: the library lists nothing after two assessments');
  } else {
    const personaName = (await persona.innerText()).trim();
    await persona.click();
    await page.waitForURL('**/personas/**');
    // The library's own h1 is still on screen until React swaps, so waiting for
    // "any level-1 heading" returns immediately on the wrong one.
    await page.getByRole('heading', { name: 'Where it has been seen', level: 2 }).waitFor({ timeout: 20000 });
    const dossierText = await page.locator('#main-content').innerText();
    if (!dossierText.includes(personaName)) failures.push(`personas: the dossier does not name ${personaName}`);
    if (!/seen in 2 papers/.test(dossierText)) failures.push('personas: the dossier does not say it was seen twice');
    for (const expected of ['What the library holds', 'Where it has been seen', 'Enquiries you commissioned']) {
      if (!dossierText.includes(expected)) failures.push(`personas: the dossier is missing "${expected}"`);
    }
    // A persona is CONTEXT, NEVER EVIDENCE, and the page has to say so: it is
    // drawn from other papers about other policies, and the one thing it must
    // not read like is a finding about the assessment in front of the reader.
    if (!/context, not evidence/i.test(dossierText)) {
      failures.push('personas: the dossier does not say it is context rather than evidence');
    }
    if ((await page.locator('#main-content a[href*="/assessments/"]').count()) < 2) {
      failures.push('personas: the dossier does not link back to both papers that named it');
    }
    if (!(await page.title()).startsWith(personaName)) failures.push('personas: the tab does not name the body');
    await audit('/personas/:id');
    note(`dossier opens on "${personaName}", seen in two papers`);
  }

  // 9c — THE ADMIN PANEL, and the lock on it.
  //
  // This is the only authentication in the service and the only page holding
  // credentials, so the assertions are about what must NOT get through. Note
  // what is not tested here because it must not exist: an address check. Behind
  // a tunnel every request arrives from 127.0.0.1, so a gate on the client
  // address passes for the whole internet.
  const locked = await page.evaluate(async () => {
    const out = {};
    for (const [name, path, method] of [
      ['config', '/api/admin/config', 'GET'],
      ['save', '/api/admin/config/openrouter', 'POST'],
      ['active', '/api/admin/active', 'POST'],
      ['test', '/api/admin/test', 'POST'],
    ]) {
      const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      out[name] = res.status;
    }
    return out;
  });
  for (const [name, status] of Object.entries(locked)) {
    if (status !== 401) failures.push(`admin: ${name} answered ${status} without a session, expected 401`);
  }
  note('the admin API refuses everything without a session');

  await page.goto(`http://127.0.0.1:${PORT}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Configuration', level: 1 }).waitFor({ timeout: 20000 });
  if (!(await page.getByLabel('Admin password').count())) failures.push('admin: no password form');
  // A wrong password must not sign anyone in, and must say nothing useful.
  await page.getByLabel('Admin password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').waitFor({ timeout: 10000 });
  if (!/not the password/i.test(await page.getByRole('alert').innerText())) {
    failures.push('admin: a wrong password did not say so');
  }
  if (await page.getByRole('heading', { name: 'Which service answers' }).count()) {
    failures.push('admin: a wrong password got in');
  }

  await page.getByLabel('Admin password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Which service answers' }).waitFor({ timeout: 20000 });
  const panel = await page.locator('#main-content').innerText();
  for (const name of ['OpenRouter', 'Azure AI Foundry', 'Codex bridge']) {
    if (!panel.includes(name)) failures.push(`admin: ${name} is not offered`);
  }
  await audit('/admin (signed in)');

  // A SECRET GOES IN AND DOES NOT COME OUT. This is the assertion the whole
  // page is shaped around: the server reports whether one is set, never what.
  const secret = 'sk-or-walk-secret-value-9f2b';
  await page.locator('#openrouter-apiKey').fill(secret);
  await page.getByRole('button', { name: 'Save OpenRouter' }).click();
  await page.waitForTimeout(600);
  const readBack = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/admin/config')).json()));
  if (readBack.includes(secret)) failures.push('admin: the saved key comes back out of the config endpoint');
  if (!/"apiKey":true/.test(readBack)) failures.push('admin: the panel cannot tell that a key is stored');
  if ((await page.locator('#openrouter-apiKey').inputValue()) !== '') {
    failures.push('admin: the secret box is pre-filled, so blank cannot mean "leave it alone"');
  }

  /*
   * AZURE ASKS HOW TO AUTHENTICATE BEFORE IT ASKS FOR ANYTHING ELSE.
   *
   * A tenant with local authentication switched off has no key to type, which
   * until phase 18 meant the service could not be configured at all. Four modes
   * now share one form and `showWhen` reveals only what the chosen one needs —
   * eight fields of which a reader fills in one to three.
   *
   * This is browser behaviour and there is no jsdom in this repo, so the walk is
   * the only thing that can see it. Without this assertion the conditional
   * rendering could break and every gate would stay green.
   */
  const azureMode = page.locator('#azure-authMode');
  if (!(await azureMode.count())) {
    failures.push('admin: Azure does not ask how to authenticate');
  } else {
    if (await page.locator('#azure-clientSecret').count()) {
      failures.push('admin: a client secret is shown while the mode is an API key');
    }
    await azureMode.selectOption('entra-app');
    await page.waitForTimeout(200);
    for (const field of ['tenantId', 'clientId', 'clientSecret']) {
      if (!(await page.locator(`#azure-${field}`).count())) {
        failures.push(`admin: choosing an app registration does not reveal ${field}`);
      }
    }
    if (await page.locator('#azure-apiKey').count()) {
      failures.push('admin: the API key box stays on screen for an Entra configuration');
    }
    // Managed identity is the one that needs nothing, and a form still asking
    // for a tenant would be a form the reader cannot finish.
    await azureMode.selectOption('managed-identity');
    await page.waitForTimeout(200);
    if (await page.locator('#azure-tenantId').count()) {
      failures.push('admin: a managed identity is asked for a tenant it does not need');
    }
    await azureMode.selectOption('key');
    await page.waitForTimeout(200);
    if (!(await page.locator('#azure-apiKey').count())) {
      failures.push('admin: going back to key authentication does not bring the key box back');
    }
  }
  note('Azure asks how to authenticate, and shows only what that answer needs');

  // And a fixture build must not be able to reach anything, however configured.
  const tested = await page.evaluate(async () => (await (await fetch('/api/admin/test', { method: 'POST' })).json()));
  if (tested.ok) failures.push('admin: the FIXTURE build reported a working provider, which it cannot have');
  if (!/fixture/i.test(tested.message ?? '')) {
    failures.push(`admin: the fixture build's failure does not say why — ${tested.message}`);
  }

  // ── The model menu ───────────────────────────────────────────────────────
  //
  // The catalogue is INVENTORY and the menu is a DECISION, and the failure this
  // guards is the two being confused: a picker that offers everything a provider
  // sells is a picker nobody can use, and a menu that silently loses a choice
  // when the search narrows is worse than no search at all.
  const menuBefore = await page.evaluate(async () =>
    (await (await fetch('/api/admin/config')).json()).menu.map((m) => m.id));
  if (menuBefore.length !== 5) {
    failures.push(`admin: expected the five built-in models before anything is chosen, got ${menuBefore.length}`);
  }

  await page.getByRole('button', { name: /^Browse what/ }).click();
  await page.getByLabel('Search the catalogue').waitFor({ timeout: 10000 });

  // With the box empty, only what is already chosen is listed — otherwise this
  // is a wall of checkboxes rather than a control.
  const boxes = 'section[aria-labelledby="admin-models"] .govuk-checkboxes__item';
  const emptyQuery = await page.locator(boxes).count();
  if (emptyQuery > menuBefore.length) {
    failures.push(`admin: an empty search listed ${emptyQuery} models, which is a wall not a menu`);
  }

  await page.getByLabel('Search the catalogue').fill('flash-latest');
  await page.waitForTimeout(250);
  const floating = page.locator('input[value="~deepseek/deepseek-flash-latest"]');
  if (!(await floating.count())) {
    failures.push('admin: searching for flash-latest does not find the floating alias');
  } else {
    // A floating id is a different KIND of choice and the panel has to say so:
    // the model behind it changes without the id changing, so two assessments a
    // month apart are not comparable though the provenance names the same thing.
    const hint = await page.locator(boxes, { has: floating }).innerText();
    if (!/redirects to whatever is newest/i.test(hint)) {
      failures.push('admin: a floating alias is offered without saying what floating means');
    }
    await floating.check();
  }

  // Narrowing the search must not drop it. This is the trap `Checkboxes` was
  // fixed for, and the fix only stays fixed if something keeps checking.
  await page.getByLabel('Search the catalogue').fill('claude');
  await page.waitForTimeout(250);
  if (await page.locator('input[value="~deepseek/deepseek-flash-latest"]').count()) {
    failures.push('admin: the search did not actually narrow');
  }
  await page.getByRole('button', { name: 'Save the menu' }).click();
  await page.waitForTimeout(600);

  const menuAfter = await page.evaluate(async () =>
    (await (await fetch('/api/admin/config')).json()).menu);
  if (!menuAfter.some((m) => m.id === '~deepseek/deepseek-flash-latest')) {
    failures.push('admin: a model ticked and then filtered out of view was lost on save');
  }
  if (menuAfter.length !== menuBefore.length + 1) {
    failures.push(`admin: saving the menu changed it to ${menuAfter.length}, expected ${menuBefore.length + 1}`);
  }

  // The submit form is the only reason this menu exists, so ask it, not the
  // panel that just wrote it.
  const offered = await page.evaluate(async () =>
    (await (await fetch('/api/policy-analysis')).json()).models.map((m) => m.id));
  if (!offered.includes('~deepseek/deepseek-flash-latest')) {
    failures.push('admin: the chosen model never reached the assessment picker');
  }

  // And the reset puts the build's own five back rather than emptying it.
  await page.getByRole('button', { name: /^Reset to the built-in/ }).click();
  await page.waitForTimeout(600);
  const menuReset = await page.evaluate(async () =>
    (await (await fetch('/api/admin/config')).json()));
  if (menuReset.menu.length !== menuBefore.length || menuReset.menuChosen) {
    failures.push(`admin: reset left ${menuReset.menu.length} models, chosen=${menuReset.menuChosen}`);
  }
  note('the model menu is chosen from the catalogue, and survives the search');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Admin password').waitFor({ timeout: 10000 });
  const after = await page.evaluate(async () => (await fetch('/api/admin/config')).status);
  if (after !== 401) failures.push(`admin: still signed in after signing out (${after})`);
  note('the panel signs in, hides its secrets, and signs out');

  /*
   * 9b — THE SETUP JOURNEY.
   *
   * The task list's statuses are the SERVER's, derived from what the install
   * actually holds, so this is really a test of that derivation: the one status
   * that cannot be derived — has a model actually answered — must not read
   * "done" on a fixture build, whose provider throws by design.
   *
   * It also asserts the thing a wizard is for: that it survives being left. The
   * journey has no state of its own, so a reader who closes the tab half way
   * through and comes back finds the same list saying the same things.
   */
  // SIGNED OUT, FIRST. The journey handles credentials, so it is behind the
  // same password the panel is — and a reader who arrives without a session
  // must be told that rather than watching a spinner that never resolves.
  await page.goto(`http://127.0.0.1:${PORT}/setup`, { waitUntil: 'networkidle' });
  if (!(await page.getByRole('heading', { name: 'Sign in to set this up', level: 1 }).isVisible())) {
    failures.push('setup: opening it without a session does not say to sign in');
  }
  await audit('/setup (signed out)');

  await page.goto(`http://127.0.0.1:${PORT}/admin`, { waitUntil: 'networkidle' });
  await page.getByLabel('Admin password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Which service answers' }).waitFor({ timeout: 20000 });

  await page.goto(`http://127.0.0.1:${PORT}/setup`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Get this service working', level: 1 }).waitFor({ timeout: 20000 });
  const tasks = page.locator('.govuk-task-list__item');
  if ((await tasks.count()) < 5) failures.push(`setup: only ${await tasks.count()} tasks in the list`);
  const listText = await page.locator('#main-content').innerText();
  if (!/Try the connection/.test(listText)) failures.push('setup: the task list does not include the connection test');
  // A FIXTURE BUILD CANNOT HAVE REACHED A MODEL, so this must not say done.
  const testRow = page.locator('.govuk-task-list__item', { hasText: 'Try the connection' });
  if (!/To do/.test(await testRow.innerText())) {
    failures.push(`setup: the fixture build claims it has reached a model — ${await testRow.innerText()}`);
  }
  await audit('/setup');

  // One thing per page, and each step is reachable from the list.
  for (const [href, heading] of [
    ['/setup/service', 'Which service answers'],
    ['/setup/access', 'Who can reach it'],
    ['/setup/spend', 'What one run may spend'],
    ['/setup/egress', 'What this needs to reach'],
    ['/setup/test', 'Try the connection'],
  ]) {
    await page.goto(`http://127.0.0.1:${PORT}${href}`, { waitUntil: 'networkidle' });
    if (!(await page.getByRole('heading', { name: heading, level: 1 }).isVisible())) {
      failures.push(`setup: ${href} has no "${heading}" heading`);
    }
    await audit(href);
  }

  // The egress list comes from the providers themselves, so a firewall change
  // can be written from one place.
  await page.goto(`http://127.0.0.1:${PORT}/setup/egress`, { waitUntil: 'networkidle' });
  // NOT a specific hostname: this is the FIXTURE registry, whose whole point is
  // that no real provider endpoint survives into the bundle — `build.mjs`
  // asserts it. What is checked is that the list is assembled from the
  // definitions at all, and that the "what it does not do" half is there, since
  // that is the half a network team actually argues about.
  const egressRows = await page.locator('#main-content table tbody tr').count();
  if (egressRows < 1) failures.push('setup: the egress list has no rows');
  const egress = await page.locator('#main-content').innerText();
  if (!/no telemetry/i.test(egress)) failures.push('setup: the egress page does not say what it does NOT do');

  // And the test step tells the truth about a build that cannot reach anything.
  await page.goto(`http://127.0.0.1:${PORT}/setup/test`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Try it' }).click();
  await page.waitForTimeout(1200);
  const outcome = await page.locator('#setup-test').innerText();
  if (!/did not answer/i.test(outcome)) {
    failures.push(`setup: the fixture build's connection test did not report a failure — "${outcome}"`);
  }
  if (!/fixture/i.test(outcome)) {
    failures.push(`setup: the failure does not say why — "${outcome}"`);
  }
  note('the setup journey lists what is left, and the test step tells the truth');

  // 10 — the rest of the surface
  for (const [route, heading] of [['/personas', 'Persona library'], ['/design', 'Design system'], ['/accessibility', 'Accessibility statement'], ['/about', 'About this tool']]) {
    await page.goto(`http://127.0.0.1:${PORT}${route}`, { waitUntil: 'networkidle' });
    if (!(await page.getByRole('heading', { name: heading, level: 1 }).isVisible())) failures.push(`${route}: no "${heading}" heading`);
    await audit(route);
  }
  note('remaining routes');
} catch (err) {
  failures.push(`walk stopped: ${err.message}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  server.kill('SIGKILL');
  await rm(dataRoot, { recursive: true, force: true });
}

if (failures.length) {
  console.error('\nFAILED');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('\nPASSED — submit to report, with axe clean on every page');
