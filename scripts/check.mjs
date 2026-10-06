import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const files = ['src', 'scripts', 'test', 'public'].flatMap(dir => readdirSync(dir).filter(name => /\.(mjs|js)$/.test(name)).map(name => `${dir}/${name}`));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
console.log(`Syntax verified: ${files.length} JavaScript files.`);
