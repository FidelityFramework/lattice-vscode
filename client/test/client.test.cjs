'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../extension.cjs');
const manifest = require('../package.json');

function harness({ trusted = true, folders, command = 'dotnet', args = ['/local path/Lattice.dll'], start, dispose, constructorFails = false, timeout = 30000, notifications } = {}) {
    const events = [], clients = [], watchers = [], errors = [], information = [], commands = {};
    const config = { 'server.command': command, 'server.args': args };
    const folder = { name: 'demo', index: 0, uri: { scheme: 'file', fsPath: '/workspace/demo' } };
    const disposable = () => ({ dispose() {} });
    let configurationChanged, foldersChanged;
    const vscode = {
        RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
        window: {
            showErrorMessage: async message => { errors.push(message); if (notifications) await notifications; },
            showInformationMessage: async message => { information.push(message); if (notifications) await notifications; }
        },
        commands: { registerCommand(name, action) { commands[name] = action; return disposable(); } },
        workspace: {
            isTrusted: trusted,
            workspaceFolders: folders ?? [folder],
            getConfiguration(section, uri) {
                assert.equal(section, 'lattice'); assert.equal(uri, folder.uri);
                return { get: (key, fallback) => config[key] ?? fallback };
            },
            createFileSystemWatcher(pattern) {
                const watcher = { pattern, disposed: false, dispose() { this.disposed = true; } };
                watchers.push(watcher); return watcher;
            },
            onDidChangeConfiguration(callback) { configurationChanged = callback; return disposable(); },
            onDidChangeWorkspaceFolders(callback) { foldersChanged = callback; return disposable(); }
        }
    };
    class LanguageClient {
        constructor(id, name, server, options) {
            if (constructorFails) throw new Error('unsupported host');
            Object.assign(this, { id, name, server, options, disposed: false }); clients.push(this);
        }
        async start() { events.push('start'); if (start) await start(); }
        async dispose() { events.push('dispose'); this.disposed = true; if (dispose) await dispose(); }
    }
    const controller = createController(vscode, LanguageClient, timeout);
    const context = { subscriptions: [] };
    return {
        controller, context, clients, watchers, errors, information, config, commands, vscode, events,
        activate: () => controller.activate(context),
        change: () => configurationChanged({ affectsConfiguration: section => section === 'lattice.server' }),
        changeFolders: () => foldersChanged()
    };
}

test('manifest owns Clef registration and contributes only implemented client settings/commands', () => {
    assert.deepEqual(manifest.contributes.languages, [{ id: 'clef', aliases: ['Clef', 'clef'], extensions: ['.clef'], icon: { light: 'images/clef.svg', dark: 'images/clef.svg' } }]);
    assert.equal(manifest.contributes.views.explorer.find(view => view.id === 'lattice.proofs').when, undefined,
        'The proof section must remain available when source links are hidden.');
    assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
    assert.deepEqual(manifest.contributes.commands.map(x => x.command), [
        'lattice.restartServer', 'lattice.refreshProofs', 'lattice.toggleProofAnnotations',
        'lattice.expandAllProofs', 'lattice.collapseAllProofs'
    ]);
    assert.ok(Object.keys(manifest.contributes.configuration.properties).every(x => x.startsWith('lattice.')));
});

test('starts the configured argv unchanged and restricts documents to Clef in this workspace', async () => {
    const h = harness({ args: ['/path with spaces/Lattice.dll', '--stdio', 'literal;$argument'] });
    await h.activate();
    const c = h.clients[0];
    assert.equal(c.id, 'lattice');
    assert.deepEqual(c.server, { command: 'dotnet', args: h.config['server.args'], options: { cwd: '/workspace/demo', shell: false } });
    const [selector] = c.options.documentSelector;
    assert.equal(selector.scheme, 'file'); assert.equal(selector.language, 'clef');
    assert.equal(selector.pattern.pattern, '**/*.clef');
    assert.equal(selector.pattern.base, c.options.workspaceFolder);
    assert.deepEqual(Object.keys(c.options).sort(), ['documentSelector', 'synchronize', 'workspaceFolder']);
    assert.equal(h.watchers[0].pattern.pattern, '**/*.{clef,fidproj}');
    await h.controller.dispose();
    assert.ok(c.disposed); assert.ok(h.watchers[0].disposed);
});

test('an unset server does not fall back to another compiler service', async () => {
    const h = harness({ command: '' }); await h.activate();
    assert.equal(h.clients.length, 0); assert.equal(h.watchers.length, 0);
    await h.controller.dispose();
});

test('does not start in untrusted, empty, multi-folder or virtual workspaces', async () => {
    for (const options of [
        { trusted: false }, { folders: [] }, { folders: [{}, {}] },
        { folders: [{ uri: { scheme: 'vscode-vfs' } }] }
    ]) {
        const h = harness(options); await h.activate();
        assert.equal(h.clients.length, 0); await h.controller.dispose();
    }
});

test('rejects malformed launch settings before creating a watcher or client', async () => {
    for (const options of [{ command: '   ' }, { command: 42 }, { args: '--stdio' }, { args: [42] }]) {
        const h = harness(options); await h.activate();
        assert.equal(h.clients.length, 0); assert.equal(h.watchers.length, 0);
        assert.equal(h.errors.length, 1); await h.controller.dispose();
    }
});

test('restarts with changed settings and releases the old watcher', async () => {
    const h = harness(); await h.activate();
    h.config['server.args'] = ['/new/Lattice.dll'];
    await h.commands['lattice.restartServer']();
    assert.deepEqual(h.events, ['start', 'dispose', 'start']);
    assert.ok(h.watchers[0].disposed);
    assert.deepEqual(h.clients[1].server.args, ['/new/Lattice.dll']);
    await h.controller.dispose();
});

test('configuration restart waits for pending startup, and shutdown prevents queued starts', async () => {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const h = harness({ start: () => blocked });
    const activation = h.activate();
    await new Promise(resolve => setImmediate(resolve));
    h.change();
    const shutdown = h.controller.dispose();
    release(); await activation; await shutdown;
    assert.deepEqual(h.events, ['start', 'dispose']);
    assert.ok(h.watchers.every(w => w.disposed));
});

test('startup failure releases resources and a later restart can recover', async () => {
    let fail = true;
    const h = harness({ start: async () => { if (fail) throw new Error('launch failed'); } });
    await h.activate();
    assert.match(h.errors[0], /launch failed/); assert.ok(h.watchers[0].disposed);
    fail = false; await h.commands['lattice.restartServer']();
    assert.equal(h.clients.length, 2); assert.equal(h.clients[1].disposed, false);
    await h.controller.dispose();
});

test('an undismissed notification does not block shutdown or retry', async () => {
    const notifications = new Promise(() => {});
    for (const options of [{ folders: [] }, { constructorFails: true }]) {
        const h = harness({ ...options, notifications });
        await h.activate(); await h.controller.dispose();
        assert.ok(h.watchers.every(w => w.disposed));
    }
});

test('a silent server startup can be cancelled during deactivation', async () => {
    const h = harness({ start: () => new Promise(() => {}), dispose: () => Promise.reject(new Error('not running')) });
    const activation = h.activate();
    await new Promise(resolve => setImmediate(resolve));
    await h.controller.dispose(); await activation;
    assert.deepEqual(h.events, ['start', 'dispose']);
    assert.deepEqual(h.errors, []); assert.ok(h.watchers[0].disposed);
});

test('initialization times out and preserves the original failure if cleanup rejects', async () => {
    const h = harness({ start: () => new Promise(() => {}), dispose: () => Promise.reject(new Error('not running')), timeout: 10 });
    await h.activate();
    assert.match(h.errors[0], /initialization timed out/);
    assert.ok(h.watchers[0].disposed); await h.controller.dispose();
});
