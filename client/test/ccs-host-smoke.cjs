'use strict';

// Loaded by the real Extension Development Host, with the real CCS server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
let observedProvider;

async function until(label, predicate, timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw new Error('Timed out waiting for ' + label);
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const plain = value => value.replaceAll('&nbsp;', ' ').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replace(/\\([\\*_{}[\]()#+.!<>/-])/g, '$1');

async function hover(uri, position) {
    const values = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
    return (values ?? []).flatMap(value => value.contents).map(content =>
        plain(typeof content === 'string' ? content : content.value)).join('\n');
}

function serializeDiagnostic(diagnostic) {
    return {
        code: diagnostic.code, source: diagnostic.source, message: diagnostic.message,
        severity: diagnostic.severity, range: diagnostic.range
    };
}

async function run() {
    const root = process.env.LATTICE_CCS_HOST_ROOT;
    assert.ok(root, 'Use node test/run-ccs-host.cjs for an isolated real-CCS workspace.');
    const demo = JSON.parse(fs.readFileSync(path.join(root, 'demo.json'), 'utf8'));
    const companion = JSON.parse(fs.readFileSync(path.join(root, 'companion.json'), 'utf8'));
    const extension = vscode.extensions.getExtension('lattice-local.lattice-clef');
    assert.ok(extension, 'Local development extension is registered.');
    assert.equal(path.resolve(extension.extensionPath), path.resolve(__dirname, '..'));
    assert.equal(vscode.workspace.isTrusted, true);
    assert.equal(extension.isActive, false, 'Capture the proof tree before the extension is activated.');

    // Capture the provider passed to the real TreeView API. No production test
    // export, synthetic server response, or replacement semantic provider.
    const proofModule = require('../proof-view.cjs');
    const originalCreate = proofModule.createProofView;
    let provider, tree;
    const expanded = [];
    const collapsed = [];
    const lensChanges = [];
    const reveals = [];
    const proofRequests = [];
    proofModule.createProofView = (api, context) => {
        // Preserve API getters lazily; enumerating window also touches proposed
        // APIs that this extension neither enables nor uses.
        const adapter = Object.create(api);
        const windowAdapter = Object.create(api.window);
        Object.defineProperty(windowAdapter, 'createTreeView', {
            value(id, options) {
                const view = api.window.createTreeView(id, options);
                if (id === 'lattice.proofs') {
                    provider = options.treeDataProvider;
                    observedProvider = provider;
                    tree = view;
                    context.subscriptions.push(view.onDidExpandElement(event => expanded.push(event.element.id)));
                    context.subscriptions.push(view.onDidCollapseElement(event => collapsed.push(event.element.id)));
                    return new Proxy(view, {
                        get(target, key) {
                            if (key === 'reveal') return async (element, options) => {
                                await target.reveal(element, options);
                                reveals.push({ id: element.id, options });
                            };
                            const value = Reflect.get(target, key, target);
                            return typeof value === 'function' ? value.bind(target) : value;
                        }
                    });
                }
                return view;
            }
        });
        Object.defineProperty(adapter, 'window', { value: windowAdapter });
        const languagesAdapter = Object.create(api.languages);
        Object.defineProperty(languagesAdapter, 'registerCodeLensProvider', {
            value(selector, lensProvider) {
                context.subscriptions.push(lensProvider.onDidChangeCodeLenses(() => {
                    const active = api.window.activeTextEditor?.document;
                    if (active) lensChanges.push({ version: active.version,
                        count: lensProvider.provideCodeLenses(active).length });
                }));
                return api.languages.registerCodeLensProvider(selector, lensProvider);
            }
        });
        Object.defineProperty(adapter, 'languages', { value: languagesAdapter });
        const proofView = originalCreate(adapter, context);
        return {
            ...proofView,
            attachClient(client) {
                // Observe real requests without replacing their transport or results.
                const observed = new Proxy(client, {
                    get(target, key) {
                        if (key === 'sendRequest') return (method, ...args) => {
                            if (method === 'clef/proofs') proofRequests.push(args[0]);
                            return target.sendRequest(method, ...args);
                        };
                        const value = Reflect.get(target, key, target);
                        return typeof value === 'function' ? value.bind(target) : value;
                    }
                });
                return proofView.attachClient(observed);
            }
        };
    };

    const toml = vscode.extensions.getExtension(companion.extensionId);
    assert.ok(toml, 'The unified host includes the isolated rich TOML companion.');
    assert.equal(toml.packageJSON.version, companion.version);
    assert.equal(path.resolve(toml.extensionPath), companion.extensionPath);
    const projectUri = vscode.Uri.file(demo.project);
    const projectDocument = await vscode.workspace.openTextDocument(projectUri);
    await vscode.window.showTextDocument(projectDocument);
    assert.equal(projectDocument.languageId, 'toml');
    await toml.activate();
    const projectTokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', projectUri);
    assert.ok(projectTokens.some(token => token.t.includes('source.toml') && token.t.includes('support.type.property-name')));
    assert.ok(projectTokens.some(token => token.t.includes('string.quoted')));
    fs.writeFileSync(path.join(root, 'project-syntax-tokens.json'), JSON.stringify(projectTokens, null, 2));

    const uri = vscode.Uri.file(demo.main);
    const document = await vscode.workspace.openTextDocument(uri);
    const original = document.getText();
    assert.equal(sha256(original), demo.sourceHashes['Main.clef'], 'The isolated source starts with the real sample.');
    try {
        await vscode.window.showTextDocument(document);
        assert.equal(document.languageId, 'clef');
        await extension.activate();
    } finally {
        proofModule.createProofView = originalCreate;
    }
    await until('proof TreeView registration', () => provider && tree);
    for (const command of ['lattice.toggleProofAnnotations', 'lattice.expandAllProofs', 'lattice.collapseAllProofs']) {
        assert.ok((await vscode.commands.getCommands()).includes(command), 'Live proof control is registered: ' + command);
    }
    const fileGroups = () => Promise.resolve(provider.getChildren());
    const contents = async (documentUri = vscode.window.activeTextEditor?.document.uri.toString()) => {
        const files = await fileGroups();
        const file = files.find(row => row.id === 'document:' + documentUri);
        return file ? provider.getChildren(file) : files;
    };
    const collectObligations = async rows => {
        const result = [];
        for (const row of rows) {
            if (row.kind === 'obligation') result.push(row);
            else result.push(...await collectObligations(await provider.getChildren(row)));
        }
        return result;
    };
    const obligations = async documentUri => collectObligations(await contents(documentUri));
    const proved = async () => {
        const rows = await obligations();
        return rows.length > 0 && rows.every(row => row.description === 'Proved · source') ? rows : undefined;
    };
    const lenses = async () => (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri) ?? [])
        .filter(lens => lens.command?.command === 'lattice.revealProofsAtSource');
    const showAnnotations = shown => vscode.workspace.getConfiguration('lattice.proofs', uri)
        .update('showAnnotations', shown, vscode.ConfigurationTarget.Workspace);
    const initialProofs = await until('current cvc5-proved source obligations', proved);
    const dimensionRows = async rows => {
        const result = [];
        for (const row of rows) {
            const details = await provider.getChildren(row);
            if (details.some(detail => /^Kind: dimension-/.test(detail.label))) result.push(row);
        }
        return result;
    };
    assert.ok((await dimensionRows(initialProofs)).length > 0,
        'Main.clef must show compiler-generated dimensional evidence, alongside string obligations.');
    const velocityLine = document.positionAt(original.indexOf('let velocity =')).line;
    const applicationProofs = [];
    for (const row of initialProofs) {
        const details = await provider.getChildren(row);
        if (details.some(detail => detail.label === 'Kind: dimension-application') &&
            details.some(detail => detail.location?.uri === uri.toString() &&
                detail.location.range.start.line === velocityLine)) {
            assert.equal(row.description, 'Proved · source');
            assert.ok(details.some(detail => detail.label === 'Logic: QF_LIA'));
            applicationProofs.push(row);
        }
    }
    assert.ok(applicationProofs.length > 0, 'The velocity call carries its own dispatched application evidence.');
    const callLens = await until('the velocity call has its own proof link', async () =>
        (await lenses()).find(lens => lens.range.start.line === velocityLine &&
            lens.command.arguments[0].ids.some(id => applicationProofs.some(row => row.id.endsWith(':obligation:' + id)))));
    assert.equal(await vscode.commands.executeCommand(callLens.command.command, ...callLens.command.arguments), true);
    fs.writeFileSync(path.join(root, 'velocity-application-proofs.json'), JSON.stringify({
        proofs: applicationProofs, lens: callLens
    }, null, 2));
    const realLiteralProofs = [];
    for (const literal of ['12.0<m>', '3.0<s>']) {
        const literalLine = document.positionAt(original.indexOf(literal)).line;
        for (const kind of ['real-literal-range', 'real-representation-coverage']) {
            let matching;
            for (const row of initialProofs) {
                const details = await provider.getChildren(row);
                if (details.some(detail => detail.label === 'Kind: ' + kind) && details.some(detail =>
                    detail.location?.uri === uri.toString() && detail.location.range.start.line === literalLine)) {
                    matching = row;
                    break;
                }
            }
            assert.ok(matching, literal + ' has its own automatically dispatched ' + kind + ' obligation.');
            assert.equal(matching.description, 'Proved · source');
            realLiteralProofs.push({ literal, kind, id: matching.id });
        }
    }
    fs.writeFileSync(path.join(root, 'real-literal-proofs.json'), JSON.stringify(realLiteralProofs, null, 2));
    const initialTree = await contents();
    const generation = initialTree[0].label;
    fs.writeFileSync(path.join(root, 'proof-tree-initial.json'), JSON.stringify(initialTree, null, 2));
    const ownSites = initialTree.filter(row => row.kind === 'source-site');
    assert.ok(ownSites.length > 1);
    const siteLines = ownSites.map(row => row.location.range.start.line);
    assert.deepEqual(siteLines, [...siteLines].sort((a, b) => a - b), 'Source drawers follow source-line order.');
    const layoutProofs = initialProofs.filter(row => row.id.endsWith(':obligation:layout_user_strings'));
    assert.equal(layoutProofs.length, 1, 'The project exposes its settled static string-pool layout obligation.');
    const layoutProof = layoutProofs[0];
    const layoutDetails = await provider.getChildren(layoutProof);
    assert.ok(layoutDetails.some(detail => detail.label === 'Kind: static-storage-layout'));
    assert.equal(layoutProof.description, 'Proved · source');
    assert.match(layoutProof.label, /BAREWire static string pool/);
    assert.ok(layoutDetails.some(detail => detail.label === 'Logic: QF_LIA'));
    assert.ok(layoutDetails.some(detail => detail.label === 'Source status: Proved'));
    assert.ok(layoutDetails.some(detail => /unsat/.test(detail.label)),
        'The pool drawer reports the solver result for the current compiler snapshot.');
    const layoutQuery = layoutDetails.find(detail => detail.label === 'Solver query');
    assert.ok(layoutQuery, 'The actual pool-layout query is inspectable from its entry-point drawer.');
    const layoutQueryRows = await provider.getChildren(layoutQuery);
    const layoutQueryHash = layoutQueryRows.find(row => row.id.endsWith(':hash')).label.replace('Query hash: ', '');
    const layoutSmt = layoutQueryRows.filter(row => row.id.includes(':query:'))
        .map(row => row.label === ' ' ? '' : row.label).join('\n');
    assert.equal(sha256(layoutSmt), layoutQueryHash);
    assert.doesNotMatch(layoutSmt, /\(declare-(?:const|fun)\s+b\d+\b/,
        'The displayed proof must consume settled offsets instead of assuming adjacency between symbolic bases.');
    assert.match(layoutSmt, /\(=\s+\(mod\s+4096\s+4096\)\s+0\)/,
        'The pool query carries the platform allocation granularity and alignment.');
    assert.match(layoutSmt, /\(<=\s+4096\s+4096\)/,
        'The settled allocation is checked against the declared platform capacity.');
    const poolEntryCount = Number(layoutProof.label.match(/(\d+) settled storages/)[1]);
    assert.ok(poolEntryCount > 1, 'The sample exercises placement of multiple storages.');
    const concretePairs = layoutSmt.match(/\(or\s+\(<=\s+\d+\s+\d+\)\s+\(<=\s+\d+\s+\d+\)\)/g) ?? [];
    assert.equal(concretePairs.length, poolEntryCount * (poolEntryCount - 1) / 2,
        'The inspected query checks every storage pair using concrete settled endpoints and offsets.');
    const mainDeclarationLine = document.positionAt(original.indexOf('let main argv')).line;
    const layoutSite = provider.getParent(layoutProof);
    assert.equal(layoutSite.kind, 'source-site');
    assert.equal(layoutSite.location.uri, uri.toString());
    const entryAttributeLine = document.positionAt(original.indexOf('[<EntryPoint>]')).line;
    const layoutLine = layoutSite.location.range.start.line;
    assert.ok([entryAttributeLine, mainDeclarationLine].includes(layoutLine),
        'The aggregate storage claim is anchored at the main declaration, including its attribute, rather than its first contributing literal.');
    const layoutLens = await until('main exposes the aggregate string-layout proof link', async () =>
        (await lenses()).find(lens => lens.range.start.line === layoutLine &&
            lens.command.arguments[0].ids.includes('layout_user_strings')));
    fs.writeFileSync(path.join(root, 'entry-layout-proof.json'), JSON.stringify({
        proof: layoutProof.id, sourceLine: layoutLine, statement: layoutProof.label, lens: layoutLens,
        sourceStatus: layoutProof.description, queryHash: layoutQueryHash, smtLib: layoutSmt
    }, null, 2));
    const comparisonLine = document.positionAt(original.indexOf('if velocity > 0.0<m/s> then')).line;
    const comparisonSite = ownSites.find(row => row.location.uri === uri.toString() &&
        row.location.range.start.line === comparisonLine);
    assert.ok(comparisonSite, 'The comparison has its own source-line drawer.');
    assert.equal(comparisonSite.label, 'Line ' + (comparisonLine + 1) + ' · ' + document.lineAt(comparisonLine).text.trim());
    const comparisonObligations = await provider.getChildren(comparisonSite);
    assert.equal(comparisonObligations.length, 3, 'The comparison and zero literal share one three-obligation drawer.');
    assert.ok(comparisonObligations.every(row => row.kind === 'obligation'));
    const comparisonKinds = [];
    for (const row of comparisonObligations) {
        const details = await provider.getChildren(row);
        comparisonKinds.push(details.find(detail => detail.label.startsWith('Kind: ')).label.slice('Kind: '.length));
        assert.equal(provider.getParent(row), comparisonSite);
    }
    assert.deepEqual(comparisonKinds.sort(), ['dimension-comparison', 'real-literal-range', 'real-representation-coverage']);
    const comparisonLens = await until('comparison proof link reports its same three obligations', async () =>
        (await lenses()).find(lens => lens.range.start.line === comparisonLine));
    assert.equal(comparisonLens.command.arguments[0].ids.length, 3);
    assert.match(comparisonLens.command.title, /3 source obligations/);
    const beforeComparisonReveal = reveals.length;
    assert.equal(await vscode.commands.executeCommand(comparisonLens.command.command, ...comparisonLens.command.arguments), true);
    assert.deepEqual(reveals.slice(beforeComparisonReveal).filter(row => row.options.select).map(row => row.id), [comparisonSite.id],
        'Clicking the source link selects the whole source drawer, rather than its last obligation.');
    assert.equal(tree.selection[0]?.id, comparisonSite.id);
    fs.writeFileSync(path.join(root, 'comparison-source-drawer.json'), JSON.stringify({
        site: comparisonSite, kinds: comparisonKinds, lens: comparisonLens, selected: tree.selection[0]?.id
    }, null, 2));
    assert.equal(vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error).length, 0);

    const velocityPosition = document.positionAt(original.indexOf('let velocity') + 'let '.length + 2);
    const velocity = await until('inferred velocity hover', async () => {
        const text = await hover(uri, velocityPosition);
        return /velocity:\s*float<\s*m\s*\/\s*s\s*>/.test(text) ? text : undefined;
    });
    const call = original.indexOf('speed distance elapsed');
    assert.ok(call >= 0);
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
        uri, document.positionAt(call + 2));
    assert.ok(definitions?.length, 'The resolved speed reference has a definition.');
    const target = definitions[0];
    const targetUri = target.targetUri ?? target.uri;
    const targetRange = target.targetSelectionRange ?? target.range;
    const unitsPath = path.join(demo.workspace, 'Units.clef');
    assert.equal(targetUri.toString(), vscode.Uri.file(unitsPath).toString());
    const speedLine = fs.readFileSync(unitsPath, 'utf8').split('\n').findIndex(line => line.startsWith('let speed '));
    assert.ok(targetRange.start.line <= speedLine && targetRange.end.line >= speedLine);

    const elapsedUse = document.positionAt(call + 'speed distance '.length + 2);
    const elapsedDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, elapsedUse);
    assert.ok(elapsedDefinitions?.length, 'The local elapsed reference has a definition.');
    const localTarget = elapsedDefinitions[0];
    assert.equal((localTarget.targetUri ?? localTarget.uri).toString(), uri.toString());
    const localRange = localTarget.targetSelectionRange ?? localTarget.range;
    const elapsedLine = document.positionAt(original.indexOf('let elapsed')).line;
    assert.ok(localRange.start.line <= elapsedLine && localRange.end.line >= elapsedLine,
        'Resolve the local elapsed binding, not the same-named parameter in Units.clef.');

    const firstProof = initialProofs[0];
    const details = await provider.getChildren(firstProof);
    const query = details.find(row => row.label === 'Solver query');
    assert.ok(query, 'Current compiler query is expandable.');
    const queryRows = await provider.getChildren(query);
    const queryHash = queryRows.find(row => row.id.endsWith(':hash')).label.replace('Query hash: ', '');
    const smt = queryRows.filter(row => row.id.includes(':query:')).map(row => row.label === ' ' ? '' : row.label).join('\n');
    assert.equal(sha256(smt), queryHash, 'Displayed query bytes match the server-projected hash.');
    assert.ok(details.some(row => row.label === 'Source status: Proved'));
    assert.ok(details.some(row => /unsat/.test(row.label)), 'Expanded status cites an actual solver result.');
    await vscode.commands.executeCommand('lattice.proofs.focus');
    await tree.reveal(firstProof, { expand: 1, focus: true, select: true });
    await tree.reveal(query, { expand: 1 });
    await until('actual tree expansion events', () => expanded.includes(firstProof.id) && expanded.includes(query.id));

    await vscode.window.showTextDocument(document);
    const sourceLenses = await until('actual source proof CodeLens', async () => {
        const current = await lenses();
        return current.length ? current : undefined;
    });
    const savedLens = sourceLenses[0].command;
    const linkedProof = initialProofs.find(row => savedLens.arguments[0].ids.some(id => row.id.endsWith(':obligation:' + id)));
    const linkedSite = provider.getParent(linkedProof);
    assert.equal(linkedSite.kind, 'source-site');
    assert.equal(await vscode.commands.executeCommand(savedLens.command, ...savedLens.arguments), true,
        'A current source CodeLens reveals its source drawer.');
    await until('CodeLens selects the source drawer', () => tree.selection[0]?.id === linkedSite.id);
    fs.writeFileSync(path.join(root, 'source-proof-lenses.json'), JSON.stringify(sourceLenses, null, 2));

    const premises = details.find(row => row.label === 'Premises');
    await tree.reveal(premises, { expand: 1, focus: false, select: false });
    await until('premises initially expand in the real tree', () => expanded.includes(premises.id));
    const presentationGeneration = (await contents())[0].label;
    const presentationTree = await fileGroups();
    const presentationRequestCount = proofRequests.length;
    const beforeHiddenCollapse = collapsed.length;
    const beforeHiddenExpansion = expanded.length;
    const beforeHiddenReveals = reveals.length;
    await vscode.commands.executeCommand('lattice.toggleProofAnnotations');
    await until('beaker hides only source annotations', async () => (await lenses()).length === 0);
    assert.equal(vscode.workspace.getConfiguration('lattice.proofs', uri).get('showAnnotations'), false);
    assert.deepEqual(await fileGroups(), presentationTree, 'Hiding source annotations retains every proof sidebar row.');
    assert.equal(collapsed.length, beforeHiddenCollapse, 'Annotation visibility does not collapse the proof tree.');
    assert.equal(expanded.length, beforeHiddenExpansion, 'Annotation visibility does not expand the proof tree.');
    assert.equal(reveals.length, beforeHiddenReveals, 'Annotation visibility does not reveal proof groups.');
    assert.equal(await vscode.commands.executeCommand(savedLens.command, ...savedLens.arguments), false,
        'A saved source control is inactive while source annotations are hidden.');

    const beforeCollapse = collapsed.length;
    await vscode.commands.executeCommand('lattice.collapseAllProofs');
    await until('Collapse All works while source annotations are hidden', () =>
        collapsed.slice(beforeCollapse).includes(firstProof.id) &&
        collapsed.slice(beforeCollapse).includes(premises.id) &&
        collapsed.slice(beforeCollapse).includes(query.id));
    const collectGroups = rows => rows.flatMap(row => row.children?.length
        ? [row, ...collectGroups(row.children)] : []);
    const allGroups = collectGroups(await fileGroups());
    assert.ok(allGroups.some(row => row.id.endsWith(':refs')), 'The current proof tree includes references to expand.');
    const beforeExpandReveals = reveals.length;
    await vscode.commands.executeCommand('lattice.expandAllProofs');
    const expandedByCommand = new Set(reveals.slice(beforeExpandReveals).map(row => row.id));
    assert.ok(allGroups.every(row => expandedByCommand.has(row.id)),
        'Expand All reveals every file, source drawer, obligation, premise, reference and solver-query group.');
    assert.equal((await lenses()).length, 0, 'Expanding the sidebar leaves source annotations hidden.');
    const beforeExpandedCollapse = collapsed.length;
    await vscode.commands.executeCommand('lattice.collapseAllProofs');
    await until('Collapse All closes the expanded obligation and raw-query groups', () =>
        collapsed.slice(beforeExpandedCollapse).includes(firstProof.id) &&
        collapsed.slice(beforeExpandedCollapse).includes(query.id));
    assert.deepEqual(await fileGroups(), presentationTree, 'Tree expansion controls preserve the proof evidence.');

    const beforeShowExpansion = expanded.length;
    const beforeShowCollapse = collapsed.length;
    const beforeShowReveals = reveals.length;
    await vscode.commands.executeCommand('lattice.toggleProofAnnotations');
    await until('beaker restores source annotations', async () => (await lenses()).length > 0);
    assert.equal(vscode.workspace.getConfiguration('lattice.proofs', uri).get('showAnnotations'), true);
    assert.equal(expanded.length, beforeShowExpansion, 'Restoring source annotations preserves the collapsed tree.');
    assert.equal(collapsed.length, beforeShowCollapse, 'Restoring source annotations does not change tree expansion.');
    assert.equal(reveals.length, beforeShowReveals, 'Restoring source annotations does not reveal proof groups.');
    assert.equal((await contents())[0].label, presentationGeneration, 'Presentation controls retain the current compiler generation.');
    // Allow any mistakenly scheduled refresh to cross the client debounce interval.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(proofRequests.length, presentationRequestCount, 'Visibility and expansion controls never redispatch proofs.');

    const elapsedText = '3.0<s>';
    const elapsedOffset = original.indexOf(elapsedText);
    assert.ok(elapsedOffset >= 0 && original.indexOf(elapsedText, elapsedOffset + 1) < 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(elapsedOffset),
        document.positionAt(elapsedOffset + elapsedText.length)), '3.0<m>');
    const beforeEditLensChanges = lensChanges.length;
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await vscode.commands.executeCommand(savedLens.command, ...savedLens.arguments), false,
        'A saved proof control from the preceding document version is refused.');
    await until('document edit clears proof lenses', () => lensChanges.slice(beforeEditLensChanges)
        .some(event => event.version === document.version && event.count === 0));
    await showAnnotations(false);
    const dimensionDiagnostic = await until('real CCS incompatible-dimension diagnostic', () => {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        fs.writeFileSync(path.join(root, 'diagnostics-after-edit.json'),
            JSON.stringify(diagnostics.map(serializeDiagnostic), null, 2));
        return diagnostics.find(diagnostic =>
            diagnostic.severity === vscode.DiagnosticSeverity.Error &&
            (typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code) === 'CCS8040' &&
            /Measure mismatch: 's' vs 'm'/.test(diagnostic.message));
    });
    assert.equal(dimensionDiagnostic.source, 'CCS');
    assert.ok(dimensionDiagnostic.range.isEqual(new vscode.Range(document.positionAt(call),
        document.positionAt(call + 'speed distance elapsed'.length))), 'CCS locates the incompatible application.');
    fs.writeFileSync(path.join(root, 'dimension-diagnostic.json'), JSON.stringify(serializeDiagnostic(dimensionDiagnostic), null, 2));
    await until('invalid snapshot is not shown as proved', async () => {
        const rows = await contents();
        return rows[0]?.label !== generation && !(await obligations()).some(row => row.description === 'Proved · source');
    });

    const restore = new vscode.WorkspaceEdit();
    restore.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
    assert.equal(await vscode.workspace.applyEdit(restore), true);
    await until('dimension error clears after restoring seconds', () =>
        !vscode.languages.getDiagnostics(uri).some(d => d.severity === vscode.DiagnosticSeverity.Error));
    assert.equal((await lenses()).length, 0, 'Checking continues with source controls hidden.');
    await until('fresh proof results remain available in the sidebar with source annotations hidden', proved);
    await showAnnotations(true);
    const restored = await until('fresh proof generation after edit restoration', async () => {
        const rows = await proved();
        return rows && (await contents())[0].label !== generation ? rows : undefined;
    });
    const restoredHover = await until('restored dimensional hover', async () => {
        const text = await hover(uri, velocityPosition);
        return /velocity:\s*float<\s*m\s*\/\s*s\s*>/.test(text) ? text : undefined;
    });
    fs.writeFileSync(path.join(root, 'proof-tree-restored.json'), JSON.stringify(await contents(), null, 2));
    assert.ok((await lenses()).length > 0, 'Restoring annotations exposes fresh source controls.');
    await until('fresh source controls return after revealing presentation', async () => (await lenses()).length > 0);
    assert.equal(await vscode.commands.executeCommand(savedLens.command, ...savedLens.arguments), false,
        'Restoring the text does not revive a saved control from an older compiler check.');

    // All edits stay unsaved in this isolated host. Source order alone must not
    // make a sibling module's bindings visible after its explicit open is removed.
    const unitsOpen = 'open HelloDimensionsProof.Units';
    const openOffset = document.getText().indexOf(unitsOpen);
    assert.ok(openOffset >= 0);
    const speedPosition = () => document.positionAt(document.getText().indexOf('speed distance elapsed') + 2);
    const speedHoverBefore = await hover(uri, speedPosition());
    assert.match(speedHoverBefore, /float</, 'The initial imported speed hover carries measured numeric types.');
    const removeOpen = new vscode.WorkspaceEdit();
    removeOpen.insert(uri, document.positionAt(openOffset), '// ');
    assert.equal(await vscode.workspace.applyEdit(removeOpen), true);
    const missingSpeed = await until('commenting out Units open produces CCS8009 at speed', () =>
        vscode.languages.getDiagnostics(uri).find(diagnostic =>
            diagnostic.source === 'CCS' && diagnostic.severity === vscode.DiagnosticSeverity.Error &&
            (typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code) === 'CCS8009' &&
            diagnostic.range.contains(speedPosition()) && /speed/.test(diagnostic.message)));
    const absentSpeed = await until('unresolved speed has neither hover nor definition', async () => {
        const text = await hover(uri, speedPosition());
        const found = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, speedPosition());
        return !text.trim() && !(found?.length) ? { hover: text, definitions: found ?? [] } : undefined;
    });
    fs.writeFileSync(path.join(root, 'scope-without-open.json'), JSON.stringify({
        version: document.version, diagnostic: serializeDiagnostic(missingSpeed), ...absentSpeed
    }, null, 2));
    const restoreOpen = new vscode.WorkspaceEdit();
    restoreOpen.delete(uri, new vscode.Range(document.positionAt(openOffset), document.positionAt(openOffset + 3)));
    assert.equal(await vscode.workspace.applyEdit(restoreOpen), true);
    await until('restoring Units open clears scope errors and restores measured hover and definition', async () => {
        if (vscode.languages.getDiagnostics(uri).some(d => d.severity === vscode.DiagnosticSeverity.Error)) return false;
        const text = await hover(uri, speedPosition());
        const found = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, speedPosition());
        const definition = found?.[0];
        if (!definition || text !== speedHoverBefore) return false;
        const definitionUri = definition.targetUri ?? definition.uri;
        const definitionRange = definition.targetSelectionRange ?? definition.range;
        return definitionUri.toString() === vscode.Uri.file(unitsPath).toString() &&
            definitionRange.start.line <= speedLine && definitionRange.end.line >= speedLine &&
            /velocity:\s*float<\s*m\s*\/\s*s\s*>/.test(await hover(uri, velocityPosition));
    });
    assert.equal(document.getText(), original, 'Scope regression restores the exact original buffer.');
    await until('proofs recover after restoring the module open', proved);

    const malformed = new vscode.WorkspaceEdit();
    malformed.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        'module HelloDimensionsProof.Main\n\nlet broken = (\n');
    assert.equal(await vscode.workspace.applyEdit(malformed), true);
    const parseState = await until('explicit parser failure in the proof panel', async () => {
        const rows = await contents();
        return rows.length === 1 && /Proof obligations unavailable:.*could not parse/i.test(rows[0].label) ? rows : undefined;
    });
    assert.equal(provider.getTreeItem(parseState[0]).command, undefined,
        'A parser failure without a compiler source range must not invent navigation.');
    fs.writeFileSync(path.join(root, 'proof-tree-parse-failure.json'), JSON.stringify(parseState, null, 2));
    const restoreParsed = new vscode.WorkspaceEdit();
    restoreParsed.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
    assert.equal(await vscode.workspace.applyEdit(restoreParsed), true);
    await until('proofs recover after restoring parseable source', proved);

    const unitsDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(unitsPath));
    const unitsSource = unitsDocument.getText();
    const unitsHovers = {};
    for (const [name, spelling, expected] of [
        ['speed', 'let speed', /speed:\s*float<\s*m\s*>\s*->\s*float<\s*s\s*>\s*->\s*float<\s*m\s*\/\s*s\s*>/],
        ['distance', '(distance:', /distance:\s*float<\s*m\s*>/],
        ['elapsed', '(elapsed:', /elapsed:\s*float<\s*s\s*>/]
    ]) {
        const start = unitsSource.indexOf(spelling);
        assert.ok(start >= 0);
        const position = unitsDocument.positionAt(start + (name === 'speed' ? 5 : 2));
        unitsHovers[name] = await until('Units ' + name + ' has its own complete measured hover', async () => {
            const text = await hover(unitsDocument.uri, position);
            return expected.test(text.replace(/[()]/g, '')) ? text : undefined;
        });
    }
    fs.writeFileSync(path.join(root, 'units-declaration-hovers.json'), JSON.stringify(unitsHovers, null, 2));
    await vscode.window.showTextDocument(unitsDocument);
    const unitProofs = await until('speed division has a cvc5-proved dimensional obligation', async () => {
        const rows = await proved();
        if (!rows) return undefined;
        const dimensional = await dimensionRows(rows);
        return dimensional.some(row => /division/i.test(row.label)) ? dimensional : undefined;
    });
    fs.writeFileSync(path.join(root, 'units-dimensional-proofs.json'), JSON.stringify(unitProofs, null, 2));
    const unitLenses = await until('speed division has a source proof drawer', async () => {
        const rows = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', unitsDocument.uri) ?? [];
        return rows.some(lens => lens.command?.command === 'lattice.revealProofsAtSource'
            && lens.range.start.line === speedLine) ? rows : undefined;
    });
    assert.ok(unitLenses.length);

    // Keep both files visible, with Main active, just as in the split editor.
    // A proof drawer belongs to its document, not only to the focused editor.
    await vscode.window.showTextDocument(unitsDocument, { viewColumn: vscode.ViewColumn.One, preview: false });
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Two, preview: false });
    const mainDimensions = await until('Main comparison remains proved in the split editor', async () => {
        const rows = await proved();
        if (!rows) return undefined;
        const dimensional = await dimensionRows(rows);
        return dimensional.some(row => /comparison/i.test(row.label)) ? dimensional : undefined;
    });
    const comparisonIds = new Set(mainDimensions.filter(row => /comparison/i.test(row.label))
        .map(row => row.id.split(':obligation:')[1]));
    const divisionIds = new Set(unitProofs.filter(row => /division/i.test(row.label))
        .map(row => row.id.split(':obligation:')[1]));
    const splitLenses = await until('both visible files retain their dimensional proof drawers', async () => {
        const [main, units] = await Promise.all([lenses(),
            vscode.commands.executeCommand('vscode.executeCodeLensProvider', unitsDocument.uri)]);
        const ownsProof = (lens, ids) => lens.command?.command === 'lattice.revealProofsAtSource'
            && lens.command.arguments?.[0]?.ids.some(id => ids.has(id));
        const comparison = main.find(lens => ownsProof(lens, comparisonIds));
        const division = (units ?? []).find(lens => lens.range.start.line === speedLine && ownsProof(lens, divisionIds));
        return comparison && division ? { comparison, division } : undefined;
    });
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), uri.toString(),
        'Main is active while the visible Units drawer remains available.');
    assert.ok(vscode.window.visibleTextEditors.some(editor => editor.document === unitsDocument));
    const inactiveDivision = splitLenses.division.command;
    assert.equal(await vscode.commands.executeCommand(inactiveDivision.command, ...inactiveDivision.arguments), true,
        'A drawer in the other visible editor reveals that document\'s proof groups.');
    const nestedFiles = await fileGroups();
    assert.deepEqual(nestedFiles.map(row => row.label), ['Units.clef', 'Main.clef'],
        'The sidebar retains one expandable group for each visible Clef file.');
    const unitsFile = nestedFiles.find(row => row.label === 'Units.clef');
    const unitsRows = await collectObligations(await provider.getChildren(unitsFile));
    const divisionRow = (await dimensionRows(unitsRows)).find(row => /division/i.test(row.label));
    assert.ok(divisionRow, 'The Units drawer reveals division evidence within its own file group.');
    const divisionSite = provider.getParent(divisionRow);
    assert.equal(divisionSite.kind, 'source-site');
    assert.equal(provider.getParent(divisionSite), unitsFile);
    assert.equal(tree.selection[0]?.id, divisionSite.id, 'The inactive editor link selects its own source drawer.');
    assert.ok(expanded.includes(unitsFile.id), 'Revealing the source drawer expands its containing file group.');
    fs.writeFileSync(path.join(root, 'split-editor-proof-lenses.json'), JSON.stringify(splitLenses, null, 2));

    const replaceDocument = async (target, text) => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(target.uri, new vscode.Range(target.positionAt(0), target.positionAt(target.getText().length)), text);
        assert.equal(await vscode.workspace.applyEdit(edit), true);
    };
    await replaceDocument(document, original.replace('12.0<m>', '1e400<m>'));
    const coverageError = await until('source-real overflow produces hard coverage error', () =>
        vscode.languages.getDiagnostics(uri).find(diagnostic => diagnostic.code === 'CCS8012'
            && diagnostic.severity === vscode.DiagnosticSeverity.Error));
    assert.match(coverageError.message, /exact source value|finite bounds/i);
    await replaceDocument(document, original);
    await until('restoring the covered source real clears the coverage error', () =>
        !vscode.languages.getDiagnostics(uri).some(diagnostic => diagnostic.code === 'CCS8012'));

    const helper = '\nlet speedIntegers (distance: int<m>) (elapsed: int<s>) = distance / elapsed\n';
    assert.ok(!unitsSource.includes('let speedIntegers'));
    await replaceDocument(unitsDocument, unitsSource + helper);
    const unused = await until('unused helper has the standard warning and fading tag', () =>
        vscode.languages.getDiagnostics(unitsDocument.uri).find(diagnostic => diagnostic.code === 'CCS8500'
            && diagnostic.severity === vscode.DiagnosticSeverity.Warning
            && diagnostic.tags?.includes(vscode.DiagnosticTag.Unnecessary)));
    assert.equal(unitsDocument.getText(unused.range), 'speedIntegers');
    const integerSource = original.replace('    let velocity = speed distance elapsed',
        '    let distanceInt = 12<m>\n    let elapsedInt = 3<s>\n' +
        '    let velocityInt = speedIntegers distanceInt elapsedInt\n    let velocity = speed distance elapsed')
        .replace('if velocity > 0.0<m/s> then', 'if velocity > 0.0<m/s> && velocityInt > 0<m/s> then');
    await replaceDocument(document, integerSource);
    await until('referencing the helper clears its unused warning', () =>
        !vscode.languages.getDiagnostics(unitsDocument.uri).some(diagnostic => diagnostic.code === 'CCS8500'));
    await until('the referenced integer helper receives a current dimensional proof', async () => {
        const rows = await obligations(unitsDocument.uri.toString());
        const divisions = (await dimensionRows(rows)).filter(row => /division/i.test(row.label));
        return divisions.length === 2 && divisions.every(row => row.description === 'Proved · source');
    });
    assert.equal(vscode.languages.getDiagnostics(uri).filter(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error).length, 0);
    fs.writeFileSync(path.join(root, 'unused-helper-warning.json'), JSON.stringify({
        ...serializeDiagnostic(unused), tags: unused.tags, clearedWhenReferenced: true
    }, null, 2));
    const integerEvidence = async (binding, literal) => {
        const offset = document.getText().indexOf('let ' + binding + ' = ' + literal);
        assert.ok(offset >= 0);
        const line = document.positionAt(offset).line;
        return until(binding + ' has proved integer range and representation evidence in its own drawer', async () => {
            const site = (await contents(uri.toString())).find(row => row.kind === 'source-site' &&
                row.location.uri === uri.toString() && row.location.range.start.line === line);
            if (!site) return undefined;
            const rows = await provider.getChildren(site);
            if (rows.length !== 2 || rows.some(row => row.kind !== 'obligation' || row.description !== 'Proved · source'))
                return undefined;
            const hashes = {};
            for (const row of rows) {
                const details = await provider.getChildren(row);
                const kind = details.find(detail => detail.label.startsWith('Kind: '))?.label.slice('Kind: '.length);
                if (!['integer-literal-range', 'integer-representation-coverage'].includes(kind)) return undefined;
                assert.ok(details.some(detail => detail.label === 'Logic: QF_LIA'));
                assert.ok(details.some(detail => detail.location?.uri === uri.toString() &&
                    detail.location.range.start.line === line));
                const query = details.find(detail => detail.label === 'Solver query');
                assert.ok(query);
                hashes[kind] = (await provider.getChildren(query)).find(detail => detail.id.endsWith(':hash'))
                    .label.replace('Query hash: ', '');
            }
            if (Object.keys(hashes).length !== 2) return undefined;
            const lens = (await lenses()).find(candidate => candidate.range.start.line === line);
            if (!lens) return undefined;
            assert.equal(lens.command.arguments[0].ids.length, 2);
            assert.match(lens.command.title, /2 source obligations/);
            assert.ok(lens.command.arguments[0].ids.every(id => rows.some(row => row.id.endsWith(':obligation:' + id))));
            return { binding, literal, site: site.id, line, hashes, lens };
        });
    };
    const integerBefore = [await integerEvidence('distanceInt', '12<m>'), await integerEvidence('elapsedInt', '3<s>')];
    assert.notEqual(integerBefore[0].site, integerBefore[1].site, 'Each measured integer binding has its own source drawer.');
    const unusedNamed = (target, name) => vscode.languages.getDiagnostics(target.uri).find(diagnostic =>
        diagnostic.code === 'CCS8500' && target.getText(diagnostic.range) === name);
    for (const name of ['distanceInt', 'elapsedInt'])
        assert.equal(unusedNamed(document, name), undefined, name + ' is used by the integer speed call.');
    const uncalledIntegerSource = integerSource
        .replace('    let velocityInt = speedIntegers distanceInt elapsedInt\n', '')
        .replace(' && velocityInt > 0<m/s>', '');
    await replaceDocument(document, uncalledIntegerSource);
    const unusedLocals = await until('removing the integer call marks both locals and its helper unused', () => {
        const rows = [unusedNamed(document, 'distanceInt'), unusedNamed(document, 'elapsedInt'),
            unusedNamed(unitsDocument, 'speedIntegers')];
        return rows.every(diagnostic => diagnostic?.severity === vscode.DiagnosticSeverity.Warning &&
            diagnostic.tags?.includes(vscode.DiagnosticTag.Unnecessary)) ? rows : undefined;
    });
    const unusedIntegerFacts = [await integerEvidence('distanceInt', '12<m>'), await integerEvidence('elapsedInt', '3<s>')];
    const unusedIntegerHovers = {};
    for (const [name, expectedRange] of [
        ['distanceInt', /Range:\s*\[12,\s*12\]/], ['elapsedInt', /Range:\s*\[3,\s*3\]/]
    ]) {
        const nameOffset = document.getText().indexOf('let ' + name) + 'let '.length;
        unusedIntegerHovers[name] = await until(name + ' retains its exact source range while unused', async () => {
            const text = await hover(uri, document.positionAt(nameOffset + 1));
            return text.includes(name + ':') && expectedRange.test(text) ? text : undefined;
        });
    }
    fs.writeFileSync(path.join(root, 'unused-integer-locals.json'), JSON.stringify({
        diagnostics: unusedLocals.map(diagnostic => ({ ...serializeDiagnostic(diagnostic), tags: diagnostic.tags })),
        hovers: unusedIntegerHovers, proofs: unusedIntegerFacts
    }, null, 2));
    await replaceDocument(document, integerSource);
    await until('restoring the integer call clears both local warnings and its helper warning', () =>
        !unusedNamed(document, 'distanceInt') && !unusedNamed(document, 'elapsedInt') &&
        !unusedNamed(unitsDocument, 'speedIntegers'));
    const restoredInteger = await integerEvidence('distanceInt', '12<m>');
    const integerGeneration = (await contents())[0].label;
    const oldIntegerLink = restoredInteger.lens.command;
    await replaceDocument(document, integerSource.replace('let distanceInt = 12<m>', 'let distanceInt = 13<m>'));
    assert.equal(await vscode.commands.executeCommand(oldIntegerLink.command, ...oldIntegerLink.arguments), false,
        'Changing the integer value invalidates its previous proof link.');
    const integerAfter = await integerEvidence('distanceInt', '13<m>');
    assert.equal(integerAfter.line, integerBefore[0].line, 'The edit changes the value on the same source line.');
    assert.notEqual((await contents())[0].label, integerGeneration);
    for (const kind of ['integer-literal-range', 'integer-representation-coverage'])
        assert.notEqual(integerAfter.hashes[kind], integerBefore[0].hashes[kind],
            kind + ' uses the changed integer value rather than stale evidence.');
    fs.writeFileSync(path.join(root, 'integer-literal-proofs.json'), JSON.stringify({
        before: integerBefore, after: integerAfter
    }, null, 2));
    await replaceDocument(document, original);
    await replaceDocument(unitsDocument, unitsSource);

    for (const [file, expected] of Object.entries(demo.sourceHashes)) {
        assert.equal(sha256(fs.readFileSync(path.join(demo.source, file))), expected, 'Original sample changed: ' + file);
    }
    assert.equal(sha256(fs.readFileSync(demo.server)), demo.serverSha256, 'Server assembly changed during the test.');
    await vscode.workspace.getConfiguration('lattice', uri).update('server.command', '', vscode.ConfigurationTarget.Workspace);
    await until('proof view disconnects with the server', async () =>
        (await contents()).some(row => row.label === 'Lattice server is not connected.'));
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({
        passed: true, vscode: vscode.version, extension: extension.id,
        scope: 'Real CCS dimensional inference, definition routing, edit diagnostics, source cvc5 discharge, expandable proof tree and fresh source CodeLens controls.',
        demo, companion, velocity, restoredHover, speedDefinition: target, elapsedDefinition: localTarget,
        diagnostic: serializeDiagnostic(dimensionDiagnostic), scopeDiagnostic: serializeDiagnostic(missingSpeed),
        initialObligations: initialProofs.length, restoredObligations: restored.length,
        initialGeneration: generation, expanded, collapsed, reveals, parseFailure: parseState[0].label,
        sourceCodeLenses: sourceLenses.length, lensChanges, splitEditorDimensionalDrawers: true,
        proofRequests,
        presentationControls: 'Source annotations toggle independently; the populated sidebar expands and collapses all groups without redispatch.'
    }, null, 2));
    console.log('Real CCS Extension Development Host smoke passed.');
}

module.exports = { run: async () => {
    try { await run(); }
    catch (error) {
        const root = process.env.LATTICE_CCS_HOST_ROOT;
        if (root) {
            fs.writeFileSync(path.join(root, 'diagnostics-failure.json'), JSON.stringify(
                vscode.languages.getDiagnostics().map(([uri, diagnostics]) => ({
                    uri: uri.toString(), diagnostics: diagnostics.map(serializeDiagnostic)
                })), null, 2));
            if (observedProvider) fs.writeFileSync(path.join(root, 'proof-tree-failure.json'),
                JSON.stringify(await observedProvider.getChildren(), null, 2));
            fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: false, error: error.stack }, null, 2));
        }
        throw error;
    }
} };
