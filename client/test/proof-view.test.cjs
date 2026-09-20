'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createProofView } = require('../proof-view.cjs');

class Emitter {
    listeners = new Set();
    event = listener => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
}

function document(uri = 'file:///project/Main.clef', version = 1) {
    return { uri: { scheme: uri.split(':')[0], toString: () => uri }, version, languageId: 'clef',
        lineCount: 20, lineAt: () => ({ text: ' '.repeat(80) }) };
}

const obligation = (overrides = {}) => ({
    id: 'capacity', kind: 'buffer-capacity', logic: 'QF_LIA',
    statement: 'Declared capacity is positive', source: 'platform:input',
    refs: ['CWE-787'], status: { phase: 'source', state: 'not-dispatched' },
    ...overrides
});
const proofId = (id, uri = 'file:///project/Main.clef') => 'document:' + uri + ':obligation:' + id;
const response = (params, overrides = {}) => ({
    textDocument: { ...params.textDocument }, checkGeneration: '9223372036854775807',
    obligations: [obligation()], ...overrides
});

function harness(t, initialDocument = document()) {
    const active = new Emitter(), visible = new Emitter(), edit = new Emitter(), close = new Emitter(), configuration = new Emitter();
    const commands = new Map();
    const reveals = [];
    const executed = [];
    const progressTasks = [];
    let provider, lensProvider, onReveal, treeView;
    let showAnnotations = true;
    let viewDisposed = false;
    let lensesDisposed = false;
    const vscode = {
        EventEmitter: Emitter,
        TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        Range: class { constructor(...coordinates) { this.coordinates = coordinates; } },
        CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
        Uri: { parse: uri => ({ scheme: uri.split(':')[0], toString: () => uri }) },
        window: {
            activeTextEditor: initialDocument && { document: initialDocument },
            visibleTextEditors: [],
            onDidChangeActiveTextEditor: active.event,
            onDidChangeVisibleTextEditors: visible.event,
            withProgress(options, task) {
                const progress = { options, done: false, reports: [] };
                progressTasks.push(progress);
                return Promise.resolve(task({ report: report => progress.reports.push(report) }))
                    .finally(() => { progress.done = true; });
            },
            createTreeView(id, options) {
                assert.equal(id, 'lattice.proofs');
                provider = options.treeDataProvider;
                return treeView = {
                    dispose() { viewDisposed = true; },
                    async reveal(element, options) { reveals.push({ element, options }); await onReveal?.(); }
                };
            }
        },
        workspace: {
            onDidChangeTextDocument: edit.event, onDidCloseTextDocument: close.event,
            onDidChangeConfiguration: configuration.event,
            getConfiguration(section) {
                assert.equal(section, 'lattice.proofs');
                return { get: (key, fallback) => key === 'showAnnotations' ? showAnnotations : fallback };
            }
        },
        languages: { registerCodeLensProvider(selector, candidate) {
            assert.deepEqual(selector, { scheme: 'file', language: 'clef' });
            lensProvider = candidate;
            return { dispose() { lensesDisposed = true; } };
        } },
        commands: {
            executeCommand: async command => { executed.push(command); },
            registerCommand(id, callback) {
                commands.set(id, callback);
                return { dispose: () => commands.delete(id) };
            }
        }
    };
    const context = { subscriptions: [] };
    const view = createProofView(vscode, context);
    t.after(() => view.dispose());
    const fileContents = (uri = vscode.window.activeTextEditor?.document.uri.toString()) => {
        const files = provider.getChildren();
        const file = files.find(row => row.id === 'document:' + uri);
        return file ? provider.getChildren(file) : files;
    };
    // Older field assertions address the actual obligation rows; grouping tests
    // use fileContents to inspect the visible tree hierarchy independently.
    const flattenSites = rows => rows.flatMap(row =>
        ['source-site', 'related-sites', 'unlocated'].includes(row.kind)
            ? flattenSites(provider.getChildren(row)) : [row]);
    const contents = uri => flattenSites(fileContents(uri));
    return {
        vscode, view, treeView, provider, lensProvider, active, visible, edit, close, configuration, commands, context, reveals, executed, progressTasks,
        files: () => provider.getChildren(), fileContents, contents,
        labels: () => contents().map(row => row.label),
        lenses: (doc = vscode.window.activeTextEditor?.document) => lensProvider.provideCodeLenses(doc),
        setRevealHandler: handler => { onReveal = handler; },
        setAnnotations: value => { showAnnotations = value; configuration.fire({ affectsConfiguration: section => section === 'lattice.proofs.showAnnotations' }); },
        viewDisposed: () => viewDisposed,
        lensesDisposed: () => lensesDisposed
    };
}

function server(handler = params => response(params), capability = { version: 1 }) {
    const requests = [], notifications = new Map();
    return {
        requests, notifications,
        initializeResult: { capabilities: { experimental: { clefProofs: capability } } },
        sendRequest(method, params) {
            assert.equal(method, 'clef/proofs');
            requests.push(params);
            return Promise.resolve().then(() => handler(params));
        },
        onNotification(method, callback) {
            assert.equal(method, 'clef/proofsChanged');
            notifications.set(method, callback);
            return { dispose: () => notifications.delete(method) };
        }
    };
}

async function until(predicate) {
    for (let i = 0; i < 100; ++i) {
        if (predicate()) return;
        await delay(10);
    }
    assert.fail('Proof view did not reach expected state');
}

test('requests require the negotiated capability and an active local Clef document', async t => {
    const h = harness(t);
    for (const capability of [undefined, { version: 2 }]) {
        const client = server(undefined, capability);
        // The default argument is useful for other tests; explicitly remove this capability.
        if (!capability) delete client.initializeResult.capabilities.experimental.clefProofs;
        h.view.attachClient(client);
        await until(() => h.labels().some(label => label.includes('does not advertise')));
        assert.equal(client.requests.length, 0);
        assert.equal(client.notifications.size, 0);
    }
    const client = server();
    h.vscode.window.activeTextEditor.document.languageId = 'fsharp';
    h.view.attachClient(client);
    await until(() => h.labels()[0].startsWith('Open a local'));
    assert.equal(client.requests.length, 0);
    h.vscode.window.activeTextEditor = { document: document('untitled:Scratch') };
    h.active.fire();
    await delay(100);
    assert.equal(client.requests.length, 0);
});

test('expands real server fields without inferring discharge from a solver query', async t => {
    const h = harness(t);
    const client = server(params => response(params, { obligations: [obligation({
        smtLib: '(assert true)\n(check-sat)', queryHash: 'server-query-hash', location: null
    })] }));
    h.view.attachClient(client);
    await until(() => h.contents().length === 2);
    assert.deepEqual(client.requests[0], { textDocument: { uri: 'file:///project/Main.clef', version: 1 } });
    assert.match(h.labels()[0], /9223372036854775807/);
    const row = h.contents()[1];
    assert.equal(row.description, 'Not dispatched · source');
    assert.equal(h.provider.getTreeItem(row).collapsibleState, 1);
    const children = h.provider.getChildren(row);
    assert.ok(children.some(child => child.label === 'Source: platform:input'));
    const premises = children.find(child => child.label === 'Premises');
    assert.deepEqual(premises.children.map(child => child.label), ['Premises are not exposed by this server.']);
    const query = children.find(child => child.label === 'Solver query');
    assert.equal(h.provider.getParent(query), row);
    const unlocated = h.provider.getParent(row);
    assert.equal(unlocated.kind, 'unlocated');
    assert.equal(h.provider.getParent(unlocated), h.files()[0]);
    assert.equal(row.kind, 'obligation');
    assert.equal(h.files()[0].label, 'Main.clef');
    assert.equal(h.provider.getParent(h.files()[0]), undefined);
    assert.equal(h.provider.getParent(query.children[0]), query);
    assert.equal(h.provider.getTreeItem(query).collapsibleState, 1);
    assert.deepEqual(query.children.map(child => child.label),
        ['Query hash: server-query-hash', '(assert true)', '(check-sat)']);
});

test('displays source verdicts, explicit premises and optional navigation as supplied', async t => {
    const h = harness(t);
    const location = { uri: 'file:///project/Types.clef', range: {
        start: { line: 2, character: 4 }, end: { line: 2, character: 7 }
    } };
    h.view.attachClient(server(params => response(params, { obligations: [obligation({
        statement: '[not executable](command:evil)', location, premises: ['capacity = 1024'],
        status: { phase: 'source', state: 'proved', detail: 'Current cvc5 dispatch returned unsat.' }
    })] })));
    await until(() => h.contents().length === 2);
    const row = h.contents()[1], item = h.provider.getTreeItem(row);
    assert.equal(row.description, 'Proved · source');
    assert.equal(item.tooltip, '[not executable](command:evil)');
    assert.equal(item.command, undefined);
    const source = row.children.find(child => child.label.startsWith('Source:'));
    const sourceItem = h.provider.getTreeItem(source);
    assert.equal(sourceItem.command.command, 'vscode.open');
    assert.deepEqual(sourceItem.command.arguments[1].selection.coordinates, [2, 4, 2, 7]);
    source.location = { ...location, uri: 'command:evil' };
    assert.equal(h.provider.getTreeItem(source).command, undefined);
    assert.deepEqual(row.children.find(child => child.label === 'Premises').children.map(child => child.label),
        ['capacity = 1024']);
});

test('edited document versions discard delayed results, including late request errors', async t => {
    const h = harness(t), deferred = [];
    h.view.attachClient(server(params => new Promise((resolve, reject) => deferred.push({ params, resolve, reject }))));
    await until(() => deferred.length === 1);
    h.vscode.window.activeTextEditor.document.version = 2;
    h.edit.fire({ document: h.vscode.window.activeTextEditor.document });
    assert.deepEqual(h.labels(), ['Refreshing source obligations…']);
    await until(() => deferred.length === 2);
    deferred[1].resolve(response(deferred[1].params, { checkGeneration: 'new-check' }));
    await until(() => h.labels()[0].includes('new-check'));
    deferred[0].reject(new Error('obsolete failure'));
    await delay(10);
    assert.match(h.labels()[0], /new-check/);
});

test('repeated focus and visibility events share pending proof requests for both editors', async t => {
    const h = harness(t), pending = [];
    const main = h.vscode.window.activeTextEditor.document;
    const units = document('file:///project/Units.clef');
    h.vscode.window.visibleTextEditors = [{ document: units }, { document: main }];
    const client = server(params => new Promise(resolve => pending.push({ params, resolve })));
    h.view.attachClient(client);
    await until(() => pending.length === 2);
    for (const active of [units, main, units]) {
        h.vscode.window.activeTextEditor = { document: active };
        h.active.fire();
        h.visible.fire();
        await delay(110);
        assert.equal(client.requests.length, 2, 'Already-pending visible documents do not request proofs again.');
    }
    for (const request of pending) request.resolve(response(request.params, { checkGeneration: 'shared-check' }));
    await until(() => h.files().every(file => file.children[0].label.includes('shared-check')));
    h.active.fire();
    await delay(110);
    assert.equal(client.requests.length, 2, 'Completed snapshots remain reusable after shared requests finish.');
});

test('old completions cannot remove newer pending checks or reconnect requests for the same document', async t => {
    const h = harness(t), oldPending = [], newPending = [];
    const old = server(params => new Promise((resolve, reject) => oldPending.push({ params, resolve, reject })));
    h.view.attachClient(old);
    await until(() => oldPending.length === 1);
    old.notifications.get('clef/proofsChanged')({}); // New check, unchanged document version.
    await until(() => oldPending.length === 2);
    oldPending[0].resolve(response(oldPending[0].params, { checkGeneration: 'obsolete' }));
    await delay(10);
    h.active.fire();
    await delay(110);
    assert.equal(old.requests.length, 2, 'An old success cannot evict the newer pending check.');
    assert.ok(!h.labels()[0].includes('obsolete'));

    const current = server(params => new Promise(resolve => newPending.push({ params, resolve })));
    h.view.attachClient(current);
    await until(() => newPending.length === 1);
    oldPending[1].reject(new Error('old client failed late'));
    await delay(10);
    h.visible.fire();
    await delay(110);
    assert.equal(current.requests.length, 1, 'An old failure cannot evict the new client request.');
    assert.ok(!h.labels()[0].includes('old client failed late'));
    newPending[0].resolve(response(newPending[0].params, { checkGeneration: 'new-client' }));
    await until(() => h.labels()[0].includes('new-client'));
});

test('a failed pending request is released so focus can retry without a new source version', async t => {
    const h = harness(t), pending = [];
    const client = server(params => new Promise((resolve, reject) => pending.push({ params, resolve, reject })));
    h.view.attachClient(client);
    await until(() => pending.length === 1);
    pending[0].reject(new Error('temporary proof request failure'));
    await until(() => h.labels()[0].includes('temporary proof request failure'));
    h.active.fire();
    await until(() => pending.length === 2);
    assert.deepEqual(pending[1].params, pending[0].params, 'The unchanged document can retry a failed request.');
    pending[1].resolve(response(pending[1].params, { checkGeneration: 'retried' }));
    await until(() => h.labels()[0].includes('retried'));
    assert.equal(client.requests.length, 2);
});

test('native view progress covers shared pending work and ends when all visible requests finish', async t => {
    const h = harness(t), pending = [];
    const main = h.vscode.window.activeTextEditor.document;
    const units = document('file:///project/Units.clef');
    h.vscode.window.visibleTextEditors = [{ document: units }, { document: main }];
    h.view.attachClient(server(params => new Promise((resolve, reject) => pending.push({ params, resolve, reject }))));
    await until(() => pending.length === 2);
    assert.equal(h.progressTasks.length, 1, 'Visible requests share one native progress lifetime.');
    const progress = h.progressTasks[0];
    assert.deepEqual(progress.options, { location: { viewId: 'lattice.proofs' } });
    assert.deepEqual(progress.reports, [], 'Pending requests do not fabricate a completion percentage.');
    assert.equal(progress.done, false, 'Progress remains active while the compiler or solver is pending.');
    h.active.fire();
    h.visible.fire();
    await delay(110);
    assert.equal(h.progressTasks.length, 1, 'Shared focus refreshes do not start duplicate progress.');
    pending[0].resolve(response(pending[0].params));
    await delay(10);
    assert.equal(progress.done, false, 'Completing one visible file does not hide the remaining work.');
    pending[1].reject(new Error('compiler unavailable'));
    await until(() => progress.done);
    // Retry the failed file, then demonstrate that a cached focus has no progress.
    h.active.fire();
    await until(() => pending.length === 3);
    pending[2].resolve(response(pending[2].params));
    await until(() => h.progressTasks[1].done);
    h.active.fire();
    await delay(110);
    assert.equal(h.progressTasks.length, 2, 'Completed snapshots do not show progress on focus.');
});

test('progress stops on invalidation disconnect and disposal despite unresolved old requests', async t => {
    const h = harness(t), pending = [];
    const client = server(params => new Promise(resolve => pending.push({ params, resolve })));
    h.view.attachClient(client);
    await until(() => pending.length === 1);
    const first = h.progressTasks[0];
    client.notifications.get('clef/proofsChanged')({});
    await until(() => first.done);
    await until(() => pending.length === 2);
    const second = h.progressTasks[1];
    pending[0].resolve(response(pending[0].params, { checkGeneration: 'obsolete' }));
    await delay(10);
    assert.equal(second.done, false, 'An obsolete completion cannot stop current progress.');
    h.view.detachClient();
    await until(() => second.done);
    assert.deepEqual(h.labels(), ['Lattice server is not connected.']);
    h.view.attachClient(client);
    await until(() => pending.length === 3);
    const third = h.progressTasks[2];
    h.view.dispose();
    await until(() => third.done);
    assert.ok(h.progressTasks.every(progress => progress.done));
});

test('dependency edits and any proofsChanged payload invalidate unchanged-document results', async t => {
    const h = harness(t), deferred = [];
    const client = server(params => new Promise(resolve => deferred.push({ params, resolve })));
    h.view.attachClient(client);
    await until(() => deferred.length === 1);
    h.edit.fire({ document: document('file:///project/Dependency.clef', 2) });
    await until(() => deferred.length === 2);
    deferred[0].resolve(response(deferred[0].params, { checkGeneration: 'obsolete' }));
    await delay(10);
    assert.ok(!h.labels()[0].includes('obsolete'));
    deferred[1].resolve(response(deferred[1].params));
    await until(() => h.contents().length === 2);
    client.notifications.get('clef/proofsChanged')({ checkGeneration: null });
    assert.deepEqual(h.labels(), ['Refreshing source obligations…']);
    await until(() => deferred.length === 3);
    deferred[2].resolve(response(deferred[2].params, { checkGeneration: 'after-invalidation' }));
    await until(() => h.labels()[0].includes('after-invalidation'));
});

test('editor switches and server restarts do not reuse a previous proof snapshot', async t => {
    const h = harness(t), pending = [];
    const old = server(params => new Promise(resolve => pending.push({ params, resolve })));
    h.view.attachClient(old);
    await until(() => pending.length === 1);
    h.vscode.window.activeTextEditor = { document: document('file:///project/Other.clef') };
    h.active.fire();
    await until(() => pending.length === 2);
    h.view.detachClient();
    assert.equal(old.notifications.size, 0);
    const current = server(params => response(params, { checkGeneration: 'new-server' }));
    h.view.attachClient(current);
    await until(() => h.labels()[0].includes('new-server'));
    for (const request of pending) request.resolve(response(request.params, { checkGeneration: 'old-server' }));
    await delay(10);
    assert.match(h.labels()[0], /new-server/);
    assert.equal(current.requests[0].textDocument.uri, 'file:///project/Other.clef');
});

test('bad responses and server errors replace rows with an error, never a previous success', async t => {
    const h = harness(t);
    let mode = 'valid';
    const client = server(params => {
        if (mode === 'error') throw new Error('ContentModified: source changed');
        if (mode === 'wrong-version') return response(params, { textDocument: { ...params.textDocument, version: 0 } });
        if (mode === 'wrong-phase') return response(params, { obligations: [obligation({
            status: { phase: 'lowering', state: 'proved' }
        })] });
        if (mode === 'duplicates') return response(params, { obligations: [obligation(), obligation()] });
        return response(params);
    });
    h.view.attachClient(client);
    await until(() => h.contents().length === 2);
    for (mode of ['wrong-version', 'wrong-phase', 'duplicates', 'error']) {
        h.commands.get('lattice.refreshProofs')();
        assert.deepEqual(h.labels(), ['Refreshing source obligations…']);
        await until(() => h.labels()[0].startsWith('Proof obligations unavailable:'));
        assert.equal(h.contents().length, 1);
    }
});

test('empty obligation sets make no proof claim and disposal stops subscriptions and requests', async t => {
    const h = harness(t);
    const client = server(params => response(params, { obligations: [] }));
    h.view.attachClient(client);
    await until(() => h.labels().includes('No obligations were returned for this document.'));
    assert.ok(!h.labels().some(label => label.includes('Proved')));
    h.commands.get('lattice.refreshProofs')();
    const count = client.requests.length;
    h.view.dispose();
    h.edit.fire({ document: document() });
    await delay(100);
    assert.equal(client.requests.length, count);
    assert.equal(client.notifications.size, 0);
    assert.equal(h.commands.size, 0);
    assert.equal(h.active.listeners.size + h.edit.listeners.size + h.close.listeners.size, 0);
    assert.equal(h.configuration.listeners.size, 0);
    assert.ok(h.viewDisposed());
    assert.ok(h.lensesDisposed());
});

const sourceLocation = (line, character = 2, uri = 'file:///project/Main.clef') => ({ uri, range: {
    start: { line, character }, end: { line, character: character + 4 }
} });

test('source-site groups sort source order and share the CodeLens grouping without mixing origins', async t => {
    const source = document();
    source.lineAt = line => ({ text: line === 3 ? 'let distance = 12.0<m>' : ' '.repeat(80) });
    const h = harness(t, source);
    h.view.attachClient(server(params => response(params, { obligations: [
        obligation({ id: 'later', location: sourceLocation(7) }),
        obligation({ id: 'other', location: sourceLocation(3, 12), status: { phase: 'source', state: 'unknown' } }),
        obligation({ location: sourceLocation(3), status: { phase: 'source', state: 'proved' } }),
        obligation({ id: 'missing' }),
        obligation({ id: 'foreign', location: sourceLocation(3, 2, 'file:///project/Types.clef') }),
        obligation({ id: 'command', location: sourceLocation(3, 2, 'command:evil') }),
        obligation({ id: 'past-end', location: sourceLocation(25) }),
        obligation({ id: 'past-column', location: sourceLocation(3, 79) })
    ] })));
    await until(() => h.contents().length === 9);
    const children = h.fileContents();
    assert.match(children[0].label, /^Source obligations · check /, 'Generation remains first.');
    const sites = children.filter(row => row.kind === 'source-site');
    assert.equal(sites.length, 2, 'Shuffled obligations on one source line form one source group.');
    assert.deepEqual(sites.map(row => row.location.range.start.line), [3, 7]);
    assert.equal(sites[0].label, 'Line 4 · let distance = 12.0<m>');
    assert.equal(sites[0].location.uri, source.uri.toString());
    assert.deepEqual(new Set(sites[0].children.map(row => row.id)), new Set([proofId('capacity'), proofId('other')]));
    assert.ok(sites[0].children.every(row => row.kind === 'obligation'));
    assert.match(sites[0].description, /2 obligations/);
    assert.match(sites[0].description, /1 proved, 1 unknown/);
    const related = children.find(row => row.kind === 'related-sites');
    assert.ok(related, 'Foreign source locations get a separate related-source section.');
    assert.equal(related.children.length, 1);
    assert.equal(related.children[0].kind, 'source-site');
    assert.equal(related.children[0].location.uri, 'file:///project/Types.clef');
    assert.deepEqual(related.children[0].children.map(row => row.id), [proofId('foreign')]);
    const unlocated = children.find(row => row.kind === 'unlocated');
    assert.ok(unlocated, 'Missing or unusable locations remain visible without source navigation.');
    assert.deepEqual(new Set(unlocated.children.map(row => row.id)),
        new Set(['missing', 'command', 'past-end', 'past-column'].map(id => proofId(id))));
    assert.equal(h.provider.getTreeItem(unlocated).command, undefined);
    const lenses = h.lenses();
    assert.equal(lenses.length, sites.length);
    assert.deepEqual(lenses[0].range.coordinates, [3, 2, 3, 2]);
    assert.equal(lenses[0].command.title, '$(beaker) 2 source obligations · 1 proved, 1 unknown');
    assert.match(lenses[0].command.tooltip, /source site/);
    assert.match(lenses[1].command.title, /1 source obligation · 1 not dispatched/);
    assert.deepEqual(new Set(lenses[0].command.arguments[0].ids), new Set(['capacity', 'other']));
    const clicked = await h.commands.get(lenses[0].command.command)(...lenses[0].command.arguments);
    assert.equal(clicked, true);
    assert.deepEqual(h.reveals.map(call => call.element), [sites[0]],
        'A source link reveals its line group without opening every proof detail.');
    assert.deepEqual(h.reveals.map(call => call.options), [{ expand: 1, focus: true, select: true }]);
    assert.equal(h.provider.getParent(sites[0].children[0]), sites[0]);
    assert.equal(h.provider.getParent(sites[0]), h.files()[0]);
    assert.deepEqual(h.lenses(document('file:///project/Types.clef')), []);
});

test('split editors retain both proof drawers and route inactive drawer clicks to their own evidence', async t => {
    const h = harness(t);
    const main = h.vscode.window.activeTextEditor.document;
    const units = document('file:///project/Units.clef');
    h.vscode.window.visibleTextEditors = [{ document: units }, { document: main }];
    const client = server(params => response(params, { obligations: [obligation({
        id: params.textDocument.uri.endsWith('Units.clef') ? 'division' : 'comparison',
        location: sourceLocation(3, 2, params.textDocument.uri)
    })] }));
    h.view.attachClient(client);
    await until(() => h.lenses(main).length === 1 && h.lenses(units).length === 1);
    assert.deepEqual(h.files().map(row => row.label), ['Units.clef', 'Main.clef']);
    assert.equal(h.contents()[1].id, proofId('comparison'));
    assert.equal(h.contents(units.uri.toString())[1].id, proofId('division', units.uri.toString()));
    const [ticket] = h.lenses(units)[0].command.arguments;
    const reveal = h.commands.get('lattice.revealProofsAtSource');
    assert.equal(await reveal(ticket), true);
    assert.equal(h.reveals.at(-1).element.kind, 'source-site');
    assert.deepEqual(h.reveals.at(-1).element.children.map(row => row.id), [proofId('division', units.uri.toString())]);
    assert.equal(h.provider.getParent(h.reveals.at(-1).element), h.files()[0]);
    assert.deepEqual(h.files().map(row => row.label), ['Units.clef', 'Main.clef'], 'Selecting a drawer retains both file groups.');
    h.vscode.window.activeTextEditor = { document: units };
    h.active.fire();
    assert.equal(h.lenses(main).length, 1, 'Changing focus must not erase a current sibling drawer.');
    assert.equal(await reveal(ticket), true, 'Focus changes preserve current proof tickets.');
    ++main.version;
    h.edit.fire({ document: main });
    assert.deepEqual(h.lenses(units), [], 'An edit invalidates evidence in dependent sibling files too.');
    assert.equal(await reveal(ticket), false);
    await until(() => h.lenses(main).length === 1 && h.lenses(units).length === 1);
});

test('file groups distinguish shared anchors and retain sibling evidence when one request fails', async t => {
    const h = harness(t);
    const main = h.vscode.window.activeTextEditor.document;
    const units = document('file:///project/Units.clef');
    h.vscode.window.visibleTextEditors = [{ document: units }, { document: main }];
    let failUnits = false;
    h.view.attachClient(server(params => {
        if (failUnits && params.textDocument.uri === units.uri.toString()) throw new Error('Units unavailable');
        return response(params);
    }));
    await until(() => h.files().every(file => file.children.length === 2));
    const files = h.files();
    assert.notEqual(h.contents(units.uri.toString())[1].id, h.contents(main.uri.toString())[1].id,
        'The same compiler anchor in two document responses has distinct tree identities.');
    h.active.fire();
    assert.equal(h.files()[0], files[0], 'Focus changes preserve the current file tree and expansion state.');
    failUnits = true;
    h.commands.get('lattice.refreshProofs')();
    await until(() => h.files()[0].children[0].label.includes('Units unavailable') && h.contents().length === 2);
    assert.equal(h.contents(main.uri.toString())[1].description, 'Not dispatched · source');
    assert.equal(h.files()[0].children.length, 1, 'The failed file does not retain its prior obligations.');
});

test('stale generation, URI, version and invalidated lens commands never reveal a group', async t => {
    const h = harness(t);
    const client = server(params => response(params, { obligations: [obligation({ location: sourceLocation(3) })] }));
    h.view.attachClient(client);
    await until(() => h.lenses().length === 1);
    const [ticket] = h.lenses()[0].command.arguments;
    const reveal = h.commands.get('lattice.revealProofsAtSource');
    for (const invalid of [
        { ...ticket, checkGeneration: 'old' }, { ...ticket, uri: 'file:///project/Other.clef' },
        { ...ticket, version: 0 }, { ...ticket, ids: ['invented'] }
    ]) assert.equal(await reveal(invalid), false);
    h.vscode.window.activeTextEditor.document.version = 2;
    assert.deepEqual(h.lenses(), []);
    assert.equal(await reveal(ticket), false);
    h.vscode.window.activeTextEditor.document.version = 1;
    let events = 0;
    h.lensProvider.onDidChangeCodeLenses(() => { ++events; });
    client.notifications.get('clef/proofsChanged')({});
    assert.deepEqual(h.lenses(), []);
    assert.ok(events > 0, 'Invalidation immediately refreshes CodeLens.');
    assert.equal(await reveal(ticket), false);
    await until(() => h.lenses().length === 1);
    assert.equal(await reveal(ticket), false, 'Same server generation still needs the current local revision.');
    assert.equal(h.reveals.length, 0);
});

test('invalidation during asynchronous source-site reveal refuses the obsolete ticket', async t => {
    const h = harness(t);
    const client = server(params => response(params, { obligations: [
        obligation({ location: sourceLocation(3) }), obligation({ id: 'second', location: sourceLocation(3, 12) })
    ] }));
    h.view.attachClient(client);
    await until(() => h.lenses().length === 1);
    h.setRevealHandler(() => client.notifications.get('clef/proofsChanged')({}));
    assert.equal(await h.commands.get('lattice.revealProofsAtSource')(...h.lenses()[0].command.arguments), false);
    assert.equal(h.reveals.length, 1);
    assert.deepEqual(h.lenses(), []);
});

test('annotation visibility changes only source links, retaining the tree and live proof requests', async t => {
    const h = harness(t);
    h.setAnnotations(false);
    const client = server(params => response(params, { obligations: [obligation({
        location: sourceLocation(3), premises: ['capacity = 1024'], smtLib: '(check-sat)',
        status: { phase: 'source', state: 'proved' }
    })] }));
    h.view.attachClient(client);
    await until(() => h.contents().length === 2);
    const files = h.files();
    const row = h.contents()[1];
    assert.match(row.description, /Proved/);
    assert.equal(h.treeView.description, undefined, 'The proof tree is never labelled hidden.');
    assert.deepEqual(h.lenses(), []);
    assert.ok(h.provider.getChildren(row).length > 0);
    let treeChanges = 0;
    h.provider.onDidChangeTreeData(() => ++treeChanges);
    h.setAnnotations(true);
    const [ticket] = h.lenses()[0].command.arguments;
    h.setAnnotations(false);
    assert.equal(await h.commands.get('lattice.revealProofsAtSource')(ticket), false);
    assert.strictEqual(h.files(), files);
    assert.strictEqual(h.contents()[1], row);
    assert.equal(treeChanges, 0, 'Toggling links cannot disturb tree expansion or selection.');
    assert.equal(client.requests.length, 1, 'Toggling links does not redispatch proofs.');
    client.notifications.get('clef/proofsChanged')({});
    await until(() => client.requests.length === 2 && h.contents().length === 2);
    assert.match(h.contents()[1].description, /Proved/);
    assert.deepEqual(h.lenses(), []);
    h.setAnnotations(true);
    assert.equal(h.lenses().length, 1);
});

test('Expand All and Collapse All control every drawer independently of source links', async t => {
    const h = harness(t);
    h.setAnnotations(false);
    const client = server(params => response(params, { obligations: [
        obligation({ premises: ['capacity = 1024'], smtLib: '(check-sat)' }),
        obligation({ id: 'second', premises: ['length >= 0'], smtLib: '(check-sat)' })
    ] }));
    h.view.attachClient(client);
    await until(() => h.contents().length === 3);
    const files = h.files();
    await h.commands.get('lattice.expandAllProofs')();
    assert.deepEqual(h.reveals.map(call => call.element.id), [
        'document:file:///project/Main.clef',
        h.fileContents().find(row => row.kind === 'unlocated').id,
        ...['capacity', 'second'].flatMap(id => [proofId(id), proofId(id + ':premises'),
            proofId(id + ':refs'), proofId(id + ':query')])
    ]);
    assert.ok(h.reveals.every(call => call.options.expand === 1 && !call.options.focus && !call.options.select));
    await h.commands.get('lattice.collapseAllProofs')();
    assert.deepEqual(h.executed, ['workbench.actions.treeView.lattice.proofs.collapseAll']);
    assert.strictEqual(h.files(), files, 'Collapse retains file groups and evidence.');
    assert.equal(client.requests.length, 1);
    assert.deepEqual(h.lenses(), []);
    // Later results do not force the tree back open after a manual collapse.
    client.notifications.get('clef/proofsChanged')({});
    await until(() => client.requests.length === 2 && h.contents().length === 3);
    assert.equal(h.reveals.length, 10);
});

test('explicit expansion stops on source invalidation but not on annotation toggles', async t => {
    const h = harness(t);
    await h.commands.get('lattice.expandAllProofs')();
    const client = server(params => response(params, { obligations: [obligation({ premises: ['capacity = 1024'] })] }));
    h.view.attachClient(client);
    await until(() => h.contents().length === 2);
    assert.equal(h.reveals.length, 0, 'Expansion does not become a persistent display mode.');
    for (const editSource of [false, true]) {
        let release;
        h.setRevealHandler(() => new Promise(resolve => { release = resolve; }));
        const before = h.reveals.length;
        const expanding = h.commands.get('lattice.expandAllProofs')();
        await until(() => release);
        if (editSource) {
            ++h.vscode.window.activeTextEditor.document.version;
            h.edit.fire({ document: h.vscode.window.activeTextEditor.document });
        } else h.setAnnotations(false);
        h.setRevealHandler(undefined);
        release();
        await expanding;
        assert.equal(h.reveals.length - before, editSource ? 1 : 5);
    }
});

test('Collapse All waits for pending expansion without a late reveal reopening the tree', async t => {
    const h = harness(t);
    const client = server(params => response(params, { obligations: [obligation({ premises: ['capacity = 1024'] })] }));
    h.view.attachClient(client);
    await until(() => h.contents().length === 2);
    let release;
    h.setRevealHandler(() => new Promise(resolve => { release = resolve; }));
    const expanding = h.commands.get('lattice.expandAllProofs')();
    await until(() => Boolean(release));
    const collapsing = h.commands.get('lattice.collapseAllProofs')();
    await delay(10);
    assert.deepEqual(h.executed, [], 'Collapse waits until the pending reveal completes.');
    release();
    await Promise.all([expanding, collapsing]);
    assert.deepEqual(h.executed, ['workbench.actions.treeView.lattice.proofs.collapseAll']);
    assert.equal(h.reveals.length, 1);
    assert.equal(client.requests.length, 1);
});
