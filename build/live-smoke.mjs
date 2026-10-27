/** Build an opt-in synthetic-data driver, never included in the main XPI. */
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import archiver from 'archiver';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'test/live');
const commit = execFileSync('git', ['rev-parse', 'v2.8.6'], { cwd: root, encoding: 'utf8' }).trim();
const manifest = { manifest_version: 2, name: 'MultiRoot isolated smoke driver', version: '0.0.5',
  applications: { zotero: { id: 'multiroot-smoke@local.test', strict_min_version: '10.0', strict_max_version: '10.*',
    update_url: `https://raw.githubusercontent.com/josesiqueira/zotero-watch-folder/${commit}/update.json` } } };
await new Promise((resolve, reject) => {
  const out = createWriteStream(path.join(dir, 'multiroot-smoke-driver.xpi'));
  const zip = archiver('zip'); out.on('close', resolve); out.on('error', reject); zip.on('error', reject); zip.pipe(out);
  zip.append(JSON.stringify(manifest), { name: 'manifest.json' });
  zip.file(path.join(dir, 'smoke-bootstrap.js'), { name: 'bootstrap.js' }); zip.finalize();
});
console.log('Built isolated smoke driver (requires explicit UI installation in test profile).');
