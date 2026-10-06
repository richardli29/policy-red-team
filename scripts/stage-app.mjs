/**
 * The folder a Databricks App is deployed from: built here, installed there.
 *
 * WHY NOT DEPLOY THE REPOSITORY. Databricks Apps runs `npm install` against its
 * own registry mirror, `npm-proxy.cloud.databricks.com`, and on 2026-09-24 that
 * mirror refused `xtend-4.0.2.tgz` (404) and served a corrupt `agent-base-7.1.4`
 * from inside the app — twice, deterministically — while serving both files
 * correctly to a laptop. `xtend` is under `pg`, `agent-base` under
 * `@databricks/lakebase`, and the whole install also dragged in Vite,
 * Playwright and sass to build a client that could have been built once, here.
 *
 * A second attempt that inlined only those two then failed on `scheduler`,
 * which is under React: the mirror refuses a different tarball each time, so
 * no list of exceptions will hold. So NOTHING is installed there. This stages
 * `.app/`:
 *
 *   dist/        the client, the offline pack and the server, already built.
 *                The server bundle inlines EVERY dependency.
 *   package.json no dependencies, so the platform's install has nothing to
 *                fetch.
 *   app.yaml     the repository's, with the command reduced to `node`.
 *
 * WHAT A FULL BUNDLE CANNOT CARRY is anything a package reads off disk beside
 * itself. PGlite loads its WebAssembly that way, which is why this is a
 * Lakebase-only build (`POLICY_DATABASE=lakebase` is in `app.yaml`); pdf.js's
 * fonts and colour maps are optional and `extract/pdf.ts` already works
 * without them.
 *
 * `databricks.yml` points `source_code_path` here. Run `npm run stage:app`
 * before `databricks bundle deploy`.
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = path.join(root, '.app');

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'dist'), { recursive: true });

// The client and the offline pack, exactly as `npm run build` makes them.
execSync('npm run build:offline && npm run build:client', { cwd: root, stdio: 'inherit' });
cpSync(path.join(root, 'dist', 'client'), path.join(out, 'dist', 'client'), { recursive: true });
cpSync(path.join(root, 'static'), path.join(out, 'static'), { recursive: true });
cpSync(path.join(root, 'migrations'), path.join(out, 'migrations'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'server', 'index.ts')],
  outfile: path.join(out, 'dist', 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // UNDER TEN MEGABYTES, which is the platform's ceiling per file. Unminified
  // the full bundle is 10.9MB and its map another 19.7MB. `keepNames` so a
  // stack trace in the app log still names the function it came from.
  minify: true,
  keepNames: true,
  sourcemap: false,
  logLevel: 'warning',
  alias: { $lib: path.join(root, 'src', 'lib') },
  // `pg-native` is an optional native binding `pg` only loads when asked for.
  external: ['pg-native'],
  // Much of what is inlined is CommonJS that calls `require`; an ESM bundle
  // has none unless it is given one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

// PDF.JS'S WORKER, beside the bundle. With no worker thread in Node, pdf.js
// imports `./pdf.worker.mjs` relative to its own module, which is now
// `dist/server.js`; esbuild cannot see that import and does not inline it.
// Without this file every PDF upload failed with "Setting up fake worker
// failed" (found 2026-10-05; the test runs had all been text files).
cpSync(
  path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs'),
  path.join(out, 'dist', 'pdf.worker.mjs'),
);

writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      private: true,
      type: 'module',
      description: pkg.description,
      scripts: { start: 'node dist/server.js' },
      dependencies: {},
    },
    null,
    2,
  ) + '\n',
);

// THE MODEL AND THE ADMIN GROUP COME FROM THE BUNDLE. `app.yaml` cannot read a
// bundle variable, so the prebuild passes `model` and `admin_group` in and
// they are written here. Unset, the repository's own values stand.
const fromBundle = { POLICY_DATABRICKS_ENDPOINT: process.env.POLICY_MODEL, POLICY_ADMIN_GROUP: process.env.POLICY_ADMIN_GROUP };
let appYaml = readFileSync(path.join(root, 'app.yaml'), 'utf8')
  .replace(/command:\n(?:  - .*\n)+/, 'command:\n  - node\n  - dist/server.js\n');
for (const [name, raw] of Object.entries(fromBundle)) {
  const value = raw?.trim();
  if (!value) continue;
  if (!/^[\w .@-]+$/.test(value)) throw new Error(`${name} has characters it should not: ${value}`);
  const line = new RegExp(`(- name: ${name}\\n    value: ).*\\n`);
  if (!line.test(appYaml)) throw new Error(`app.yaml has no plain value for ${name} to set.`);
  appYaml = appYaml.replace(line, (_, head) => `${head}"${value}"\n`);
}
writeFileSync(path.join(out, 'app.yaml'), appYaml);

console.log(`staged ${path.relative(root, out)}/ for databricks bundle deploy`);
