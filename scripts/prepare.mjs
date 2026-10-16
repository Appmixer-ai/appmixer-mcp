// npm lifecycle "prepare": builds dist/ so that installs straight from git
// (npm install github:Appmixer-ai/appmixer-mcp, npx github:...) get working
// bins — dist/ is not committed. Registry installs ship a prebuilt dist/ and
// never run this. Skipped when the toolchain is absent (e.g. --omit=dev), so a
// missing devDependency cannot fail an otherwise valid install.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (!existsSync(new URL('../node_modules/typescript', import.meta.url))) {
    console.log('[prepare] TypeScript not installed; skipping build.');
    process.exit(0);
}

const result = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
});
process.exit(result.status ?? 1);
