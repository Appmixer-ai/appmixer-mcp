// commit-and-tag-version updater for src/version.ts, so the release commit
// carries the same version as package.json (the build regenerates it anyway).
const PATTERN = /export const VERSION = '([^']+)';/;

module.exports.readVersion = function (contents) {
    const match = contents.match(PATTERN);
    return match ? match[1] : undefined;
};

module.exports.writeVersion = function (contents, version) {
    if (!PATTERN.test(contents)) throw new Error('VERSION export not found in src/version.ts');
    return contents.replace(PATTERN, `export const VERSION = '${version}';`);
};
