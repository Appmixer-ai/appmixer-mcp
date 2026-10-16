// Regenerates src/guide.ts from docs/flow-authoring-guide.md.
import { readFileSync, writeFileSync } from 'node:fs';

const md = readFileSync('docs/flow-authoring-guide.md', 'utf8');
const ts = '// Generated from docs/flow-authoring-guide.md - edit the markdown, then regenerate (npm run gen:guide).\n' +
    `export const FLOW_AUTHORING_GUIDE = ${JSON.stringify(md)};\n`;
writeFileSync('src/guide.ts', ts);
console.log(`src/guide.ts regenerated (${md.length} chars).`);
