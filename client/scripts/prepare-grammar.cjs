'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Read the grammar from its owning repository; do not maintain another copy.
const source = path.resolve(process.argv[2] ?? path.join(__dirname, '../../../clef-grammar/grammars/clef.json'));
const bytes = fs.readFileSync(source);
const grammar = JSON.parse(bytes);
if (grammar.scopeName !== 'source.clef' || !grammar.fileTypes?.includes('clef')) {
    throw new Error(`Expected the Clef TextMate grammar at ${source}`);
}
const destination = path.join(__dirname, '../syntaxes');
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'clef.json'), bytes);
fs.copyFileSync(path.join(__dirname, '../../LICENSE.md'), path.join(__dirname, '../LICENSE.md'));
fs.copyFileSync(path.resolve(source, '../../LICENSE.md'), path.join(destination, 'LICENSE.md'));
console.log(`Prepared source.clef from ${source} (SHA-256 ${crypto.createHash('sha256').update(bytes).digest('hex')})`);
