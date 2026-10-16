// Regenerates src/version.ts from package.json, so the version the server
// reports over MCP cannot drift from the published package version.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync('src/version.ts',
    '// Generated from package.json - run `npm run gen:version` (part of the build).\n' +
    `export const VERSION = '${version}';\n`);
console.log(`src/version.ts regenerated (${version}).`);
