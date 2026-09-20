'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareDemo } = require('../scripts/prepare-demo.cjs');

test('repreparing routes Clef and TOML without replacing source edits or unrelated settings', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-demo-settings-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const composer = path.join(root, 'Composer');
    const source = path.join(composer, 'samples/lattice/HelloDimensionsProof');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'HelloDimensionsProof.fidproj'),
        '[dependencies]\nplatform = { path = "../../../../Fidelity.Platform/Profiles/Linux_x86_64_Default/Fidelity.Platform.fidproj" }\n');
    fs.writeFileSync(path.join(source, 'Main.clef'), 'module Main\nlet answer = 42\n');
    fs.writeFileSync(path.join(source, 'Units.clef'), 'module Units\n');
    const platform = path.join(root, 'Platform.fidproj');
    const server = path.join(root, 'Server.dll');
    fs.writeFileSync(platform, '[package]\nname = "Platform"\n');
    fs.writeFileSync(server, 'fixture artifact');
    const options = { composer, platform, server, output: path.join(root, 'demo'),
        dotnet: process.execPath, solver: process.execPath };
    const first = prepareDemo(options);
    const settingsPath = path.join(first.workspace, '.vscode/settings.json');
    const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(readSettings()['files.associations'], { '*.clef': 'clef', '*.fidproj': 'toml' });

    const editedSource = 'module Main\n// an unsolved experiment\nlet answer = missing\n';
    fs.writeFileSync(first.main, editedSource);
    fs.writeFileSync(settingsPath, JSON.stringify({
        ...readSettings(),
        'files.associations': { '*.clef': 'fsharp', '*.fidproj': 'plaintext', '*.extra': 'json' },
        'workbench.colorTheme': 'My Theme',
        'editor.fontSize': 17
    }));
    const second = prepareDemo(options);
    assert.deepEqual(readSettings()['files.associations'], {
        '*.clef': 'clef', '*.fidproj': 'toml', '*.extra': 'json'
    });
    assert.equal(readSettings()['workbench.colorTheme'], 'My Theme');
    assert.equal(readSettings()['editor.fontSize'], 17);
    assert.equal(fs.readFileSync(second.main, 'utf8'), editedSource);
    assert.equal(second.preservedSourceEdits, true);
});
