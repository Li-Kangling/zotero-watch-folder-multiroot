/** Build the independent GPL multi-root fork; never publish to the upstream repository. */
import { build } from 'esbuild';
import { promises as fs, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import archiver from 'archiver';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
execFileSync(process.execPath, ['build/build.mjs'], { cwd: root, stdio: 'inherit' });
for (const [entry, globalName, outfile] of [
  ['index', '_ZoteroWatchFolderTemp', 'watchFolder'],
  ['rootEngine', '_WatchFolderRootEngine', 'rootEngine'],
  ['multiRoot', '_WatchFolderMultiRoot', 'multiRoot'],
]) {
  await build({ entryPoints: [path.join(root, 'content', entry + '.mjs')], bundle: true,
    format: 'iife', globalName, platform: 'browser', target: 'firefox128',
    outfile: path.join(dist, 'content/scripts', outfile + '.js'), external: ['zotero*'] });
}
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.applications.zotero.id !== 'watch-folder-multiroot@local.zotero') throw new Error('Unexpected addon identity');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) throw new Error('Package/manifest version mismatch');
await fs.writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
await fs.copyFile(path.join(root, 'bootstrap-multiroot.js'), path.join(dist, 'bootstrap.js'));
await fs.copyFile(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));
await fs.copyFile(path.join(root, 'MULTIROOT.md'), path.join(dist, 'MULTIROOT.md'));
await fs.rm(path.join(dist, 'prefs.js')); // original prefs are documentation, not fork defaults
const xpi = path.resolve(root, '..', `zotero-watch-folder-multiroot-${manifest.version}.xpi`);
await new Promise((resolve, reject) => {
  const output = createWriteStream(xpi), archive = archiver('zip', { zlib: { level: 9 } });
  output.on('close', resolve); output.on('error', reject); archive.on('error', reject);
  archive.pipe(output);
  // Stable order/time/mode: rebuilding unchanged source must not dirty update.json.
  const append = async (dir, prefix = '') => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await append(path.join(dir, entry.name), name + '/');
      else if (entry.isFile()) archive.append(await fs.readFile(path.join(dir, entry.name)), { name, date: new Date('2000-01-01T00:00:00Z'), mode: 0o644 });
      else throw new Error('Unexpected non-file build entry: ' + name);
    }
  };
  append(dist).then(() => archive.finalize(), reject);
});
const hash = createHash('sha256').update(await fs.readFile(xpi)).digest('hex');
await fs.writeFile(xpi + '.sha256', hash + '  ' + path.basename(xpi) + '\n');
console.log('Local package:', xpi, '\nSHA256:', hash);

const repository = pkg.repository.url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
const update = { addons: { [manifest.applications.zotero.id]: { updates: [{
  version: manifest.version, update_link: `https://github.com/${repository}/releases/download/v${manifest.version}/${path.basename(xpi)}`,
  update_hash: 'sha256:' + hash, applications: { zotero: { strict_min_version: manifest.applications.zotero.strict_min_version, strict_max_version: manifest.applications.zotero.strict_max_version } }
}] } } };
await fs.writeFile(path.join(root, 'update.json'), JSON.stringify(update, null, 2) + '\n');
