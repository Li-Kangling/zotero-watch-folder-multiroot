/** GPL corresponding source; excludes dependencies, runtime profiles and databases. */
import { createWriteStream, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import archiver from 'archiver';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let files;
try {
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
} catch {
  // Source ZIPs have no Git history; include only source roots, never runtime files.
  const allowedDirs = new Set(['.github', 'build', 'content', 'docs', 'locale', 'test', 'tools']);
  const blocked = new Set(['.git', 'node_modules', 'dist', 'profile', 'data', 'runs', 'papers']);
  files = [];
  const walk = (dir, rel = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const name = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (!blocked.has(e.name) && (rel || allowedDirs.has(e.name))) walk(path.join(dir, e.name), name);
      } else if (e.isFile() && !/\.(?:sqlite(?:-wal|-shm)?|xpi|log|pdf|zip|sha256)$/.test(e.name)
        && !/^(?:result.*\.json|process-id\.txt|\.env.*)$/.test(e.name)) files.push(name);
    }
  };
  walk(root);
}
if (files.some(f => /(?:^|\/)(?:node_modules|profile|data|runs)\//.test(f) || /\.(?:sqlite|xpi|log)$/.test(f))) throw new Error('Runtime data must not be shipped');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const outputPath = path.resolve(root, '..', `zotero-watch-folder-multiroot-${version}-source.zip`);
await new Promise((resolve, reject) => {
  const out = createWriteStream(outputPath), zip = archiver('zip', { zlib: { level: 9 } });
  out.on('close', resolve); out.on('error', reject); zip.on('error', reject); zip.pipe(out);
  for (const f of [...new Set(files)]) zip.file(path.join(root, f), { name: 'watch-folder-multiroot/' + f });
  zip.finalize();
});
console.log(outputPath);
