/**
 * The pack, opened the way a reader opens it: double-clicked, with no network.
 *
 * This is phase 5's gate, and it is deliberately not a unit test. `pack.test.ts`
 * asserts rules about the bytes — no `<link>`, no `url(/…)`, everything inline.
 * Those are proxies. This opens the actual file from `file://` in a real browser
 * with every request blocked, and checks the report is on the screen.
 *
 * ROUTE BLOCKING IS THE POINT. Playwright's `**\/*` route handler aborts every
 * request the page makes. A pack that quietly depended on a CDN would render
 * here and fail in the room with no wifi, which is the one place it exists for.
 *
 *   node scripts/offline-check.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5297;
const failures = [];
const note = (m) => console.log(`  ${m}`);

const work = await mkdtemp(path.join(tmpdir(), 'policy-offline-'));
const server = spawn(process.execPath, [path.join(ROOT, 'dist', 'server-fixture.js')], {
  env: { ...process.env, POLICY_PORT: String(PORT), POLICY_DATABASE: '', POLICY_DATA_DIR: path.join(work, 'db'), POLICY_SEAL_KEY_DIR: path.join(work, 'keys') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start')), 30000);
  server.stdout.on('data', (d) => String(d).includes('Policy Red Team on') && (clearTimeout(timer), resolve()));
});

try {
  // 1 — run an assessment through the real API
  const form = new FormData();
  form.set('title', 'Offline pack check');
  form.set('depth', 'standard');
  const { readFile } = await import('node:fs/promises');
  form.set('document', new Blob([await readFile(path.join(ROOT, 'tests/fixtures/policy-analysis/policy.txt'))], { type: 'text/plain' }), 'policy.txt');
  const created = await fetch(`http://127.0.0.1:${PORT}/api/policy-analysis`, { method: 'POST', body: form });
  if (!created.ok) throw new Error(`submit failed: ${created.status} ${await created.text()}`);
  const { id } = await created.json();
  note(`assessment ${id}`);

  // 2 — wait for it to finish
  let served = null;
  for (let i = 0; i < 240; i++) {
    const detail = await (await fetch(`http://127.0.0.1:${PORT}/api/policy-analysis/${id}`)).json();
    served = detail;
    if (['completed', 'completed_with_gaps'].includes(detail.analysis.status)) break;
    if (['failed', 'cancelled'].includes(detail.analysis.status)) throw new Error(`run ${detail.analysis.status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  note('assessment finished');

  /*
   * WHAT THE SERVICE SAYS ABOUT THE RUN, held so the pack can be checked against
   * it. The pack used to synthesise one stage per warning with `status:
   * 'completed'` written in — so on the real run it printed "Stages — 256 of 256
   * completed" for a run that failed at 17 of 18, while the service, from the
   * same assessment, printed "17 of 18". Nothing caught it, because nothing here
   * compared the two artefacts on a fact they both state.
   */
  const truth = {
    stages: `${served.stages.filter((s) => s.status === 'completed').length} of ${served.stages.length} completed`,
    model: served.analysis.model,
  };

  // 3 — download the pack and unzip it, as a reader would
  const zipped = await fetch(`http://127.0.0.1:${PORT}/api/policy-analysis/${id}/export?format=bundle`);
  if (!zipped.ok) throw new Error(`bundle failed: ${zipped.status}`);
  const zip = await JSZip.loadAsync(await zipped.arrayBuffer());
  const packDir = path.join(work, 'pack');
  await mkdir(packDir, { recursive: true });
  // The zip holds ONE dated folder, not loose files — which is right: five files
  // spilling into someone's Downloads is how a pack gets separated from its own
  // README. Everything below is relative to that folder.
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const inside = entries.map((f) => f.name.split('/').slice(1).join('/')).filter(Boolean);
  for (const expected of ['index.html', 'report.docx', 'report.md', 'MANIFEST.json', 'README.txt']) {
    if (!inside.includes(expected)) failures.push(`pack is missing ${expected}`);
  }
  for (const entry of entries) {
    const rel = entry.name.split('/').slice(1).join('/');
    if (!rel) continue;
    await mkdir(path.dirname(path.join(packDir, rel)), { recursive: true });
    await writeFile(path.join(packDir, rel), Buffer.from(await entry.async('arraybuffer')));
  }
  note(`pack extracted: ${inside.join(', ')}`);

  // 4 — the two documents beside it. A Word export that printed literal `**`
  // shipped from this codebase once: the renderer was handed markdown and wrote
  // it out as text. Checking the .docx's own XML is the only way to see it
  // without opening Word.
  const markdown = await zip.file(entries.find((f) => f.name.endsWith('report.md')).name).async('string');
  if (!markdown.startsWith('# ')) failures.push('report.md does not open with its title as a heading');
  if (markdown.length < 400) failures.push(`report.md is only ${markdown.length} characters`);

  const docx = await JSZip.loadAsync(await zip.file(entries.find((f) => f.name.endsWith('report.docx')).name).async('arraybuffer'));
  const documentXml = await docx.file('word/document.xml').async('string');
  for (const [pattern, what] of [[/\*\*/, 'bold markers (**)'], [/^#{1,6}\s/m, 'heading hashes'], [/\[[^\]]+\]\([^)]+\)/, 'markdown links']]) {
    if (pattern.test(documentXml)) failures.push(`report.docx contains literal ${what} — the markdown was written out as text`);
  }
  if (!/<w:pStyle[^>]+Heading/.test(documentXml)) failures.push('report.docx has no heading styles — it is one flat block of text');
  note(`report.md ${markdown.length} chars; report.docx has real Word headings and no raw markdown`);

  // 5 — open it from file://, with EVERY request aborted
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const attempted = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    // The page itself is the one thing that has to load.
    if (url.startsWith('file://')) return route.continue();
    attempted.push(url);
    return route.abort();
  });
  page.on('pageerror', (err) => failures.push(`page error: ${err.message}`));

  await page.goto(`file://${path.join(packDir, 'index.html')}`, { waitUntil: 'load' });
  await page.getByRole('heading', { name: 'What it found' }).waitFor({ timeout: 30000 })
    .catch(() => failures.push('the report did not render from file://'));

  const body = await page.locator('#main-content').innerText().catch(() => '');
  for (const expected of ['Offline pack check', 'Ways to beat it', 'How this was produced']) {
    if (!body.includes(expected)) failures.push(`offline page missing "${expected}"`);
  }
  if (body.length < 500) failures.push(`offline page rendered only ${body.length} characters`);

  // It must LOOK right too: GOV.UK 6 styles nothing without its shell classes,
  // and an unstyled pack is a pack nobody reads.
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (background === 'rgba(0, 0, 0, 0)') failures.push('the pack rendered unstyled — the govuk-template classes are missing');

  // TWO ARTEFACTS OF ONE ASSESSMENT MUST NOT DISAGREE, which is the pack's own
  // stated principle. This is the fact they both print.
  if (!body.includes(truth.stages)) {
    failures.push(`the pack does not agree with the service about the run: expected "${truth.stages}"`);
  }
  if (truth.model && !body.includes(truth.model)) {
    failures.push(`the pack does not name the model the run used (${truth.model})`);
  }
  note(`the pack and the service agree: stages "${truth.stages}"${truth.model ? `, model ${truth.model}` : ''}`);

  // NOTHING IS CLIPPED IN A PACK. The write-up clamps to nine lines on the
  // service, which is `overflow: hidden` — so the hidden text is out of Ctrl-F as
  // well as out of sight, and Ctrl-F is the only interface a single file:// page
  // has. A pack renders every section open.
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll('.prt-writeup__body')].filter((el) => el.scrollHeight > el.clientHeight + 2).length);
  if (clipped) failures.push(`${clipped} write-up sections are clipped in the pack, so their text cannot be searched`);

  /*
   * EVERY CONTROL IN THE PACK GETS PRESSED.
   *
   * This gate loaded the pack, read its text and passed — while pressing "How
   * they connect" threw `ReferenceError: Cannot access '_e' before
   * initialization` and left the reader on a dead button. The service build of
   * the same component was fine, which is exactly why nothing caught it: the
   * pack is a SECOND bundle — one IIFE, `lib` mode, its own minifier pass — and
   * the two disagreed about a `const` a closure captured before its declaration
   * ran.
   *
   * A pack has no console, no reload that helps and nobody to report to. So the
   * check is the blunt one: press everything, and let `pageerror` above catch
   * what falls out. `force` because a control scrolled out of view is still a
   * control, and this is not a test of scrolling.
   */
  const controls = await page.locator('button').all();
  let pressed = 0;
  for (const control of controls) {
    const label = (await control.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 40);
    try {
      await control.click({ timeout: 2000, force: true });
      pressed += 1;
    } catch {
      // A control that cannot be reached at all is worth knowing about, but an
      // element Playwright declines to click is not by itself a defect.
      note(`could not press "${label || '(no label)'}"`);
    }
    await page.waitForTimeout(60);
  }
  note(`pressed ${pressed} of ${controls.length} controls, no error`);

  if (attempted.length) failures.push(`the pack tried to reach the network: ${[...new Set(attempted)].slice(0, 5).join(', ')}`);
  else note('no request left the page');

  note(`report rendered offline, ${body.length} characters`);
  await browser.close();
} catch (err) {
  failures.push(`offline check stopped: ${err.message}`);
} finally {
  server.kill('SIGKILL');
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error('\nFAILED');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('\nPASSED — the pack opens from file:// with every request blocked');
