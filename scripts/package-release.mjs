import { readFileSync, lstatSync, mkdirSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './start.mjs';

// Local snapshot only. Explicit files; no Git history, credentials or runtime evidence.
const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const manifest = readFileSync(`${root}/RELEASE_FILES.txt`, 'utf8');
  const files = manifest.trim().split(/\r?\n/);
  if (new Set(files).size !== files.length || files.some(p => !/^[a-zA-Z0-9_.\/-]+$/.test(p) || p.startsWith('/') || p.split('/').some(s => ['..','.',''].includes(s)) ||
      /^\.git\//.test(p) || /^(data|output|node_modules)\//.test(p) || (/^\.env/.test(p) && p !== '.env.example'))) throw Error();
  const config = loadConfig(root, {});
  const privateValues = ['PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET','OPERATOR_PIN','SANDBOX_RECIPIENT_EMAIL']
    .map(k => config[k]).filter(s => s && s.length >= 8 && s !== 'payguard-demo');
  const hashes = {};
  for (const path of files) {
    // Reject symlinks in any path component, not just at the final file.
    let current = root;
    for (const part of path.split('/')) { current += `/${part}`; if (lstatSync(current).isSymbolicLink()) throw Error(); }
    if (!lstatSync(current).isFile()) throw Error();
    const bytes = readFileSync(current), text = bytes.toString('utf8');
    if (privateValues.some(s => text.includes(s))) throw Error();
    if (!path.endsWith('.png')) {
      if (/\/Users\/|\/home\/|[A-Z]:\\Users\\|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw Error();
      const emails = text.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
      if (emails.some(e => !/(?:@example\.(?:test|com)|@(?:[a-z0-9-]+\.)?example\.com)$/.test(e.toLowerCase()))) throw Error();
    }
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
  }
  const directory = `${root}/data/release`; mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${directory}/payguard-source.pending.tar.gz`, archive = `${directory}/payguard-source.tar.gz`;
  execFileSync('tar', ['-czf', temporary, '-T', `${root}/RELEASE_FILES.txt`], { cwd: root, stdio: ['ignore','ignore','pipe'] });
  chmodSync(temporary, 0o600);
  const actual = execFileSync('tar', ['-tzf', temporary], { encoding: 'utf8' }).trim().split('\n');
  if (actual.length !== files.length || actual.some((p,i) => p !== files[i])) throw Error();
  renameSync(temporary, archive);
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(`${directory}/manifest.json`, JSON.stringify({ packagedAt: new Date().toISOString(), files: hashes, archiveSha256: sha256, published: false }, null, 2)+'\n', { mode: 0o600 });
  console.log(JSON.stringify({ files: files.length, auditPassed: true, archive: 'data/release/payguard-source.tar.gz', sha256, published: false,
    licensePresent: files.includes('LICENSE'), note: 'Local snapshot only; check the pre-public review and approvals before release.' }, null, 2));
} catch {
  console.error('Release packaging stopped: review the explicit manifest, missing/symlinked files, local secrets, personal data or archive tooling. Nothing was published.');
  process.exitCode = 1;
}
