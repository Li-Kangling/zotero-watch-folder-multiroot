/** Publish only this fork, never upstream; requires a clean, pushed source commit. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const repo = 'Li-Kangling/zotero-watch-folder-multiroot';
const run = (...args) => execFileSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const origin = run('git', 'remote', 'get-url', 'origin');
if (origin !== `https://github.com/${repo}.git`) throw new Error('Refusing unexpected publication remote');
if (run('git', 'status', '--porcelain')) throw new Error('Commit source and update.json before publishing');
const manifest = JSON.parse(readFileSync(path.join(root, 'dist/manifest.json'), 'utf8'));
if (manifest.version !== pkg.version || manifest.applications.zotero.id !== 'watch-folder-multiroot@local.zotero') throw new Error('Unexpected built identity');
if (run('git', 'rev-parse', 'HEAD') !== run('git', 'rev-parse', 'origin/main')) throw new Error('Push the corresponding source commit first');
const stem = `zotero-watch-folder-multiroot-${pkg.version}`;
const notes = path.join(root, 'RELEASE_NOTES.md');
const files = [`${stem}.xpi`, `${stem}.xpi.sha256`, `${stem}-source.zip`].map(n => path.resolve(root, '..', n));
for (const f of files) readFileSync(f);
// No --clobber: a published version is immutable. Make a new version for changes.
console.log(run('gh', 'release', 'create', `v${pkg.version}`, ...files, '--repo', repo, '--target', run('git', 'rev-parse', 'HEAD'), '--title', `Watch Folder 多目录 ${pkg.version}`, '--notes-file', notes));
