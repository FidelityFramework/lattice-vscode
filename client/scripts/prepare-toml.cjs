'use strict';

// A pinned companion for the disposable development host, never the user profile.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const extensionId = 'tamasfe.even-better-toml';
const version = '0.21.2';

function prepareToml(options = {}) {
    const directory = path.resolve(options.extensionsDir ?? path.join(__dirname, '../.demo-extensions'));
    const userData = path.join(directory, '.installer-profile');
    const code = options.code ?? process.env.LATTICE_CODE ?? 'code';
    const electronCli = path.isAbsolute(code) ? [
        path.join(path.dirname(code), 'resources/app/out/cli.js'),
        path.join(path.dirname(code), '../Resources/app/out/cli.js')
    ].find(file => fs.existsSync(file)) : undefined;
    fs.mkdirSync(directory, { recursive: true });
    function cli(args) {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        if (electronCli) env.ELECTRON_RUN_AS_NODE = '1';
        const result = spawnSync(code, [...(electronCli ? [electronCli] : []), ...args,
            '--extensions-dir', directory, '--user-data-dir', userData], {
            env, encoding: 'utf8', shell: false, timeout: 120000
        });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error('VS Code companion setup failed: ' + result.stdout + result.stderr);
        return result.stdout;
    }
    const listed = () => cli(['--list-extensions', '--show-versions']).split(/\r?\n/).map(line => line.trim().toLowerCase());
    if (!listed().includes(extensionId + '@' + version)) {
        cli(['--install-extension', extensionId + '@' + version, '--force']);
    }
    if (!listed().includes(extensionId + '@' + version)) {
        throw new Error('The isolated host did not select the pinned TOML extension.');
    }
    const candidates = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .map(entry => path.join(directory, entry.name, 'package.json')).filter(file => fs.existsSync(file))
        .map(file => ({ file, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) }))
        .filter(({ manifest }) => manifest.publisher?.toLowerCase() === 'tamasfe' &&
            manifest.name === 'even-better-toml' && manifest.version === version);
    if (candidates.length !== 1) throw new Error('Expected one installed manifest for the pinned TOML companion.');
    const { file, manifest } = candidates[0];
    return {
        extensionId, version, extensionsDir: directory, extensionPath: path.dirname(file),
        manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        repository: manifest.repository ?? null
    };
}

if (require.main === module) {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
        const name = process.argv[i];
        if (!['--code', '--extensions-dir'].includes(name) || process.argv[i + 1] === undefined) {
            throw new Error('Use --code EXECUTABLE and/or --extensions-dir DIRECTORY.');
        }
        options[name === '--code' ? 'code' : 'extensionsDir'] = process.argv[i + 1];
    }
    console.log(JSON.stringify(prepareToml(options), null, 2));
}

module.exports = { prepareToml };
