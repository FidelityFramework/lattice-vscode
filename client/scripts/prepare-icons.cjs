'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let themePath;
let codePath;
for (let i = 2; i < process.argv.length; i += 2) {
    const option = process.argv[i];
    const value = process.argv[i + 1];
    if (!['--theme', '--code'].includes(option) || !value || value.startsWith('--')) {
        throw new Error('Usage: node scripts/prepare-icons.cjs [--theme /path/to/theme-seti | --code /path/to/code]');
    }
    if (option === '--theme') themePath = path.resolve(value);
    else codePath = fs.realpathSync(value);
}
const candidates = themePath ? [themePath] : codePath ? [
    path.resolve(path.dirname(codePath), 'resources/app/extensions/theme-seti'),
    path.resolve(path.dirname(codePath), '../resources/app/extensions/theme-seti'),
    path.resolve(path.dirname(codePath), '../Resources/app/extensions/theme-seti'),
] : ['/usr/share/code/resources/app/extensions/theme-seti'];
const source = candidates.find(candidate => fs.existsSync(path.join(candidate, 'icons/vs-seti-icon-theme.json')));
if (!source) throw new Error('Cannot locate VS Code Seti. Supply --theme /path/to/theme-seti (or --code /path/to/code).');

const output = path.resolve(__dirname, '../icons');
const original = fs.readFileSync(path.join(source, 'icons/vs-seti-icon-theme.json'));
const theme = JSON.parse(original);
if (!theme.iconDefinitions || !theme.fileExtensions || !theme.light?.fileExtensions || !theme.fonts?.length) {
    throw new Error(`Unsupported Seti theme structure: ${source}`);
}
const copies = new Map([
    ['vs-seti-icon-theme.json', path.join(source, 'icons/vs-seti-icon-theme.json')],
    ['ThirdPartyNotices.txt', path.join(source, 'ThirdPartyNotices.txt')],
    ['clef.svg', path.resolve(__dirname, '../images/clef.svg')],
    ['fidproj.svg', path.resolve(__dirname, '../images/fidproj.svg')],
    ['CLEF-ASSET-ATTRIBUTION.md', path.resolve(__dirname, '../images/README.md')],
]);
for (const font of theme.fonts) {
    for (const entry of font.src) {
        const relative = entry.path.replace(/^\.\//, '');
        if (path.basename(relative) !== relative || !relative.endsWith('.woff')) {
            throw new Error(`Unsupported Seti font path: ${entry.path}`);
        }
        copies.set(relative, path.join(source, 'icons', relative));
    }
}
// Read every required input before writing any output.
const inputs = [...copies].map(([name, sourcePath]) => ({ name, sourcePath, bytes: fs.readFileSync(sourcePath) }));
theme.iconDefinitions._lattice_clef = { iconPath: './clef.svg' };
theme.iconDefinitions._lattice_fidproj = { iconPath: './fidproj.svg' };
for (const variant of [theme, theme.light, ...(theme.highContrast ? [theme.highContrast] : [])]) {
    variant.fileExtensions = { ...variant.fileExtensions, clef: '_lattice_clef', fidproj: '_lattice_fidproj' };
}
fs.mkdirSync(output, { recursive: true });
const provenance = {};
for (const { name, sourcePath, bytes } of inputs) {
    fs.writeFileSync(path.join(output, name), bytes);
    provenance[name] = { source: sourcePath, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
fs.writeFileSync(path.join(output, 'lattice-icon-theme.json'), JSON.stringify(theme, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(`Prepared Lattice (Seti + Clef) from ${source}; source SHA-256 ${provenance['vs-seti-icon-theme.json'].sha256}`);
