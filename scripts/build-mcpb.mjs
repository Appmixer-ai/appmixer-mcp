// Builds the MCPB bundle: a single-file stdio server plus the manifest, packed
// into dist/appmixer-mcp-<version>.mcpb. The bundle carries its dependencies so
// the host can run it without npm or a local toolchain.
//
// Usage: npm run build:mcpb
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { build } from 'esbuild';

const STAGE = 'build/mcpb';
const OUT_DIR = 'dist';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, 'server'), { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

await build({
    entryPoints: ['src/index.ts'],
    outfile: join(STAGE, 'server', 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // No shebang banner: src/index.ts already carries one and esbuild keeps it.
    logLevel: 'info'
});

// The packaged manifest always carries the package version, so the bundle and
// the npm release cannot drift apart.
const manifest = JSON.parse(readFileSync(join('mcpb', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Optional: drop mcpb/icon.png into the repo to give the bundle an icon.
if (existsSync(join('mcpb', 'icon.png'))) {
    copyFileSync(join('mcpb', 'icon.png'), join(STAGE, 'icon.png'));
    manifest.icon = 'icon.png';
    writeFileSync(join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const output = join(OUT_DIR, `appmixer-mcp-${pkg.version}.mcpb`);
const pack = spawnSync('npx', ['--yes', '@anthropic-ai/mcpb', 'pack', STAGE, output], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
});
if (pack.status !== 0) {
    console.error('[build-mcpb] mcpb pack failed.');
    process.exit(pack.status ?? 1);
}
console.log(`[build-mcpb] ${output}`);
