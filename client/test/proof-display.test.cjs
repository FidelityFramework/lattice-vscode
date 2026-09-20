'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProofDisplay, annotationsShown } = require('../proof-display.cjs');

function harness(initial = {}) {
    const listeners = new Map(), commands = new Map(), changes = [];
    const settings = { ...initial };
    const disposable = (action = () => {}) => ({ dispose: action });
    const event = key => callback => { listeners.set(key, callback); return disposable(() => listeners.delete(key)); };
    const folder = { uri: { scheme: 'file', toString: () => 'file:///project' } };
    const uri = { scheme: 'file', toString: () => 'file:///project/Main.clef' };
    const status = {
        visible: false, disposed: false,
        show() { this.visible = true; }, hide() { this.visible = false; },
        dispose() { this.disposed = true; }
    };
    const vscode = {
        StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { WorkspaceFolder: 3 },
        window: {
            activeTextEditor: { document: { uri, languageId: 'clef', isClosed: false } },
            createStatusBarItem: () => status,
            onDidChangeActiveTextEditor: event('editor')
        },
        workspace: {
            workspaceFolders: [folder],
            onDidChangeWorkspaceFolders: event('folders'),
            onDidChangeConfiguration: event('configuration'),
            getConfiguration: (section, resource) => ({
                get: (key, fallback) => settings[key] ?? (key === 'showAnnotations' ? true : fallback),
                inspect: key => ({ defaultValue: key === 'showAnnotations' ? true : 'drawers',
                    workspaceFolderValue: settings[key] }),
                async update(key, value, target) {
                    changes.push({ section, resource, key, value, target });
                    settings[key] = value;
                    listeners.get('configuration')?.({ affectsConfiguration: name => name === 'lattice.proofs.' + key });
                }
            })
        },
        commands: { registerCommand(name, callback) { commands.set(name, callback); return disposable(() => commands.delete(name)); } }
    };
    const api = createProofDisplay(vscode, { subscriptions: [] });
    return { vscode, status, changes, api, listeners, commands, settings,
        toggle: () => commands.get('lattice.toggleProofAnnotations')() };
}

test('one click toggles source links while the beaker remains available', async () => {
    const h = harness();
    assert.equal(h.status.visible, true);
    assert.equal(h.status.text, '$(beaker) Proof links: Shown');
    assert.equal(h.status.command, 'lattice.toggleProofAnnotations');
    await h.toggle();
    assert.equal(h.status.text, '$(beaker) Proof links: Hidden');
    assert.match(h.status.tooltip, /sidebar and checking remain available/);
    assert.equal(h.status.visible, true);
    await h.toggle();
    assert.equal(h.status.text, '$(beaker) Proof links: Shown');
    assert.deepEqual(h.changes.map(change => change.value), [false, true]);
    assert.ok(h.changes.every(change => change.section === 'lattice.proofs' &&
        change.key === 'showAnnotations' && change.target === h.vscode.ConfigurationTarget.WorkspaceFolder &&
        change.resource === h.vscode.workspace.workspaceFolders[0].uri));
    h.api.dispose();
    assert.equal(h.status.disposed, true);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.commands.size, 0);
});

test('legacy Hidden is read without writes until the new setting is explicitly chosen', async () => {
    const h = harness({ display: 'hidden' });
    assert.equal(annotationsShown(h.vscode), false);
    assert.equal(h.status.text, '$(beaker) Proof links: Hidden');
    assert.deepEqual(h.changes, []);
    await h.toggle();
    assert.equal(annotationsShown(h.vscode), true);
    assert.equal(h.settings.display, 'hidden', 'The legacy preference is not rewritten.');
    assert.deepEqual(h.changes.map(change => [change.key, change.value]), [['showAnnotations', true]]);
    h.api.dispose();
    for (const display of ['drawers', 'full', undefined]) {
        const other = harness({ display });
        assert.equal(annotationsShown(other.vscode), true);
        assert.deepEqual(other.changes, []);
        other.api.dispose();
    }
});

test('explicit new settings at every supported scope override legacy Hidden', () => {
    for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue',
        'globalLanguageValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue']) {
        const api = { workspace: { getConfiguration: () => ({
            get: key => key === 'showAnnotations' ? true : 'hidden',
            inspect: () => ({ defaultValue: true, [scope]: true })
        }) } };
        assert.equal(annotationsShown(api), true, scope);
    }
    const h = harness({ showAnnotations: false, display: 'full' });
    assert.equal(annotationsShown(h.vscode), false);
    h.api.dispose();
});

test('source-link toggle stays reachable from TOML and with no active editor', async () => {
    const h = harness();
    h.vscode.window.activeTextEditor.document.languageId = 'toml';
    h.listeners.get('editor')();
    assert.equal(h.status.visible, true);
    await h.toggle();
    assert.equal(h.status.text, '$(beaker) Proof links: Hidden');
    h.vscode.window.activeTextEditor = undefined;
    h.listeners.get('editor')();
    assert.equal(h.status.visible, true);
    await h.toggle();
    assert.equal(h.status.text, '$(beaker) Proof links: Shown');
    h.api.dispose();
});

test('source-link toggle is absent for unsupported workspace contexts', async () => {
    const h = harness();
    for (const folders of [[], [{}, {}], [{ uri: { scheme: 'vscode-vfs' } }]]) {
        h.vscode.workspace.workspaceFolders = folders;
        h.listeners.get('folders')();
        assert.equal(h.status.visible, false);
        await h.toggle();
        assert.deepEqual(h.changes, []);
    }
    h.api.dispose();
});

test('rapid clicks serialize to two toggles instead of writing the same value twice', async () => {
    const h = harness();
    await Promise.all([h.toggle(), h.toggle()]);
    assert.deepEqual(h.changes.map(change => change.value), [false, true]);
    h.api.dispose();
});

test('queued toggles cannot update another workspace or continue after disposal', async () => {
    for (const dispose of [false, true]) {
        const h = harness();
        const pending = h.toggle();
        if (dispose) h.api.dispose();
        else h.vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', toString: () => 'file:///another' } }];
        await pending;
        assert.deepEqual(h.changes, []);
        h.api.dispose();
    }
});
