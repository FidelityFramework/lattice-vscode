'use strict';

const { annotationsShown } = require('./proof-display.cjs');

// A projection of the negotiated clefProofs v1 response, never a proof checker.
const states = new Map([
    ['not-dispatched', 'Not dispatched'],
    ['running', 'Running'],
    ['proved', 'Proved'],
    ['counterexample', 'Counterexample'],
    ['unknown', 'Unknown'],
    ['error', 'Error']
]);

function statusSummary(obligations) {
    const counts = new Map();
    for (const row of obligations) counts.set(row.status.state, (counts.get(row.status.state) ?? 0) + 1);
    return [...states].filter(([state]) => counts.has(state))
        .map(([state, label]) => `${counts.get(state)} ${label.toLowerCase()}`).join(', ');
}

function validateResponse(result, uri, version) {
    const invalid = () => { throw new Error('Invalid clef/proofs v1 response.'); };
    if (!result || result.textDocument?.uri !== uri || result.textDocument.version !== version ||
        typeof result.checkGeneration !== 'string' || result.checkGeneration === '' ||
        !Array.isArray(result.obligations)) invalid();
    const ids = new Set();
    for (const row of result.obligations) {
        if (!row || ['id', 'kind', 'logic', 'statement', 'source'].some(key => typeof row[key] !== 'string') ||
            row.id === '' || ids.has(row.id) || !Array.isArray(row.refs) ||
            row.refs.some(ref => typeof ref !== 'string') || row.status?.phase !== 'source' ||
            !states.has(row.status.state)) invalid();
        ids.add(row.id);
        for (const key of ['smtLib', 'queryHash']) {
            if (row[key] !== undefined && typeof row[key] !== 'string') invalid();
        }
        if (row.status.detail !== undefined && typeof row.status.detail !== 'string') invalid();
        if (row.premises !== undefined && (!Array.isArray(row.premises) ||
            row.premises.some(premise => typeof premise !== 'string'))) invalid();
        if (row.location !== undefined && row.location !== null) {
            const { uri: locationUri, range } = row.location ?? {};
            const positions = [range?.start, range?.end];
            if (typeof locationUri !== 'string' || !positions.every(position => position &&
                Number.isInteger(position.line) && position.line >= 0 &&
                Number.isInteger(position.character) && position.character >= 0) ||
                range.end.line < range.start.line ||
                (range.end.line === range.start.line && range.end.character < range.start.character)) invalid();
        }
    }
    return result;
}

function createProofView(vscode, context) {
    const changed = new vscode.EventEmitter();
    const lensesChanged = new vscode.EventEmitter();
    let client;
    let notification;
    let timer;
    let revision = 0;
    let disposed = false;
    let rows = [];
    const documentSnapshots = new Map();
    const documentErrors = new Map();
    const pendingRequests = new Map();
    let refreshProgress;
    let presentationRevision = 0;
    let presentationWork = Promise.resolve();

    const leaf = (id, label, extra = {}) => ({ id, label, ...extra });
    const group = (id, label, children, extra = {}) => ({ id, label, children, ...extra });
    const publish = next => {
        rows = next;
        changed.fire(undefined);
        lensesChanged.fire(undefined);
    };
    const message = text => publish([leaf('message', text)]);
    const activeDocument = () => {
        const document = vscode.window.activeTextEditor?.document;
        return document?.languageId === 'clef' && document.uri.scheme === 'file' && !document.isClosed
            ? document : undefined;
    };
    const visibleDocuments = () => [...new Map([
        ...(vscode.window.visibleTextEditors ?? []).map(editor => editor.document), activeDocument()
    ].filter(document => document?.languageId === 'clef' && document.uri.scheme === 'file' && !document.isClosed)
        .map(document => [document.uri.toString(), document])).values()];
    const supported = () => client?.initializeResult?.capabilities?.experimental?.clefProofs?.version === 1;
    const documentKey = uri => 'document:' + uri;
    const siteKey = (documentUri, sourceUri, line) => documentKey(documentUri) + ':site:' + encodeURIComponent(sourceUri) + ':' + line;
    const showAnnotations = (document = activeDocument()) => {
        const folder = vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined;
        return annotationsShown(vscode, document?.uri ?? folder?.uri ?? null);
    };

    function currentProofs(document) {
        const snapshot = documentSnapshots.get(document?.uri.toString());
        return !disposed && supported() && snapshot?.client === client &&
            snapshot.token === revision && document?.languageId === 'clef' &&
            document.uri.scheme === 'file' && !document.isClosed &&
            snapshot.result.textDocument.version === document.version;
    }

    // The tree and source links must count the same usable locations. Invalid
    // locations remain visible under Other obligations without navigation.
    function usableLocation(location, document) {
        if (!location) return false;
        try { if (new URL(location.uri).protocol !== 'file:') return false; } catch { return false; }
        if (document?.uri.toString() === location.uri) {
            const { start, end } = location.range;
            return end.line < document.lineCount &&
                start.character <= document.lineAt(start.line).text.length &&
                end.character <= document.lineAt(end.line).text.length;
        }
        return true;
    }

    function sourceSites(document) {
        if (!currentProofs(document) || !showAnnotations(document)) return [];
        const sites = new Map();
        for (const row of documentSnapshots.get(document.uri.toString()).result.obligations) {
            const location = row.location;
            if (!usableLocation(location, document) || location.uri !== document.uri.toString()) continue;
            const { start } = location.range;
            let site = sites.get(start.line);
            if (!site) sites.set(start.line, site = { line: start.line, character: start.character, obligations: [] });
            site.character = Math.min(site.character, start.character);
            site.obligations.push(row);
        }
        return [...sites.values()].sort((a, b) => a.line - b.line);
    }

    const lensProvider = {
        onDidChangeCodeLenses: lensesChanged.event,
        provideCodeLenses(document) {
            return sourceSites(document).map(site => {
                const summary = statusSummary(site.obligations);
                const count = site.obligations.length;
                return new vscode.CodeLens(new vscode.Range(site.line, site.character, site.line, site.character), {
                    command: 'lattice.revealProofsAtSource',
                    title: `$(beaker) ${count} source obligation${count === 1 ? '' : 's'} · ${summary}`,
                    tooltip: 'Show compiler-provided obligations for this source site in Clef Proofs.',
                    arguments: [{ token: revision, uri: document.uri.toString(), version: document.version,
                        checkGeneration: documentSnapshots.get(document.uri.toString()).result.checkGeneration, line: site.line,
                        ids: site.obligations.map(row => row.id) }]
                });
            });
        }
    };

    async function revealSource(ticket) {
        const document = visibleDocuments().find(document => document.uri.toString() === ticket?.uri);
        const snapshot = documentSnapshots.get(ticket?.uri);
        if (!document || !currentProofs(document) || !showAnnotations(document) ||
            ticket.token !== revision || ticket.version !== document.version ||
            ticket.checkGeneration !== snapshot.result.checkGeneration) return false;
        const site = sourceSites(document).find(candidate => candidate.line === ticket.line);
        if (!site || !Array.isArray(ticket.ids) || site.obligations.length !== ticket.ids.length ||
            site.obligations.some((row, index) => row.id !== ticket.ids[index])) return false;
        const valid = () => {
            if (!ticket || !currentProofs(document) || !showAnnotations(document) ||
                documentSnapshots.get(ticket.uri) !== snapshot ||
                ticket.token !== revision || ticket.uri !== document.uri.toString() ||
                ticket.version !== document.version || ticket.checkGeneration !== snapshot.result.checkGeneration) return undefined;
            const site = sourceSites(document).find(candidate => candidate.line === ticket.line);
            if (!site || !Array.isArray(ticket.ids) || site.obligations.length !== ticket.ids.length ||
                site.obligations.some((row, index) => row.id !== ticket.ids[index])) return undefined;
            const file = rows.find(element => element.id === documentKey(ticket.uri));
            return file?.children.find(element => element.id === siteKey(ticket.uri, ticket.uri, ticket.line));
        };
        const sourceGroup = valid();
        if (!sourceGroup) return false;
        try {
            // Keep the whole source site's obligations in view. Individual
            // proof details remain drawers, rather than focusing the last one.
            await view.reveal(sourceGroup, { expand: 1, focus: true, select: true });
        } catch (error) {
            if (valid()) throw error;
            return false;
        }
        return Boolean(valid());
    }

    function expandAll() {
        ++presentationRevision;
        const snapshotRows = rows;
        const token = revision;
        const modeRevision = presentationRevision;
        const current = () => !disposed && revision === token && rows === snapshotRows &&
            presentationRevision === modeRevision;
        const collect = siblings => siblings.flatMap(row => row.children?.length
            ? [row, ...collect(row.children ?? [])] : []);
        const groups = collect(rows);
        // Expansion is an explicit tree action. Source annotation visibility
        // and later proof refreshes must not override the user's collapse state.
        presentationWork = presentationWork.then(async () => {
            for (const group of groups) {
                if (!current()) return;
                await view.reveal(group, { expand: 1, focus: false, select: false });
            }
        }).catch(error => {
            if (current()) console.error('Lattice could not expand the current proof groups:', error);
        });
        return presentationWork;
    }

    function collapseAll() {
        ++presentationRevision;
        const modeRevision = presentationRevision;
        const current = () => !disposed && presentationRevision === modeRevision;
        // Serialize behind an in-flight expansion so a late reveal cannot
        // reopen a group after Collapse All. The current evidence stays intact.
        presentationWork = presentationWork.then(async () => {
            if (current()) await vscode.commands.executeCommand('workbench.actions.treeView.lattice.proofs.collapseAll');
        }).catch(error => {
            if (current()) console.error('Lattice could not collapse the proof groups:', error);
        });
        return presentationWork;
    }

    function project(result) {
        const prefix = documentKey(result.textDocument.uri);
        const document = visibleDocuments().find(document => document.uri.toString() === result.textDocument.uri &&
            document.version === result.textDocument.version);
        const output = [leaf(prefix + ':generation', 'Source obligations · check ' + result.checkGeneration)];
        const sites = new Map();
        const unlocated = [];
        for (const row of result.obligations) {
            const key = prefix + ':obligation:' + row.id;
            const location = usableLocation(row.location, document) ? row.location : undefined;
            const children = [
                leaf(key + ':statement', 'Statement: ' + row.statement),
                leaf(key + ':id', 'Anchor: ' + row.id),
                leaf(key + ':kind', 'Kind: ' + row.kind),
                leaf(key + ':logic', 'Logic: ' + row.logic),
                leaf(key + ':source', 'Source: ' + row.source, { location }),
                leaf(key + ':status', 'Source status: ' + states.get(row.status.state))
            ];
            if (row.status.detail !== undefined) children.push(leaf(key + ':detail', row.status.detail));
            children.push(group(key + ':premises', 'Premises', row.premises?.length
                ? row.premises.map((premise, i) => leaf(key + ':premise:' + i, premise))
                : [leaf(key + ':premises-empty', row.premises === undefined
                    ? 'Premises are not exposed by this server.'
                    : 'No separate premises were supplied.')]));
            if (row.refs.length) children.push(group(key + ':refs', 'References',
                row.refs.map((ref, i) => leaf(key + ':ref:' + i, ref))));
            if (row.smtLib !== undefined || row.queryHash !== undefined) {
                const query = [];
                if (row.queryHash !== undefined) query.push(leaf(key + ':hash', 'Query hash: ' + row.queryHash));
                if (row.smtLib !== undefined) {
                    query.push(...row.smtLib.split(/\r?\n/).map((line, i) => leaf(key + ':query:' + i, line || ' ')));
                }
                children.push(group(key + ':query', 'Solver query', query));
            }
            const proof = group(key, row.statement, children, {
                kind: 'obligation', description: states.get(row.status.state) + ' · source'
            });
            if (!location) { unlocated.push(proof); continue; }
            const { uri, range } = location;
            const id = siteKey(result.textDocument.uri, uri, range.start.line);
            let site = sites.get(id);
            if (!site) {
                site = { id, uri, line: range.start.line, range, proofs: [], obligations: [] };
                sites.set(id, site);
            }
            // One group matches the source CodeLens's start-line grouping.
            // Its navigation range is the union of the supplied source spans.
            const before = (left, right) => left.line < right.line ||
                (left.line === right.line && left.character < right.character);
            site.range = {
                start: before(range.start, site.range.start) ? range.start : site.range.start,
                end: before(site.range.end, range.end) ? range.end : site.range.end
            };
            site.proofs.push(proof);
            site.obligations.push(row);
        }
        const sourceGroup = site => {
            const local = site.uri === result.textDocument.uri;
            let name = site.uri;
            try { name = decodeURIComponent(new URL(site.uri).pathname.split('/').pop()) || site.uri; } catch { /* Keep the supplied origin readable. */ }
            const snippet = local && document && site.line < document.lineCount
                ? document.lineAt(site.line).text.trim() : '';
            const location = { uri: site.uri, range: site.range };
            const heading = local ? `Line ${site.line + 1}` : `${name}:${site.line + 1}`;
            const label = snippet ? heading + ' · ' + (snippet.length > 100 ? snippet.slice(0, 100) + '…' : snippet) : heading;
            const count = site.proofs.length;
            return group(site.id, label, site.proofs, {
                kind: 'source-site', location,
                description: `${count} obligation${count === 1 ? '' : 's'} · ${statusSummary(site.obligations)}`,
                tooltip: `${site.uri}:${site.line + 1}` + (snippet ? '\n' + snippet : '')
            });
        };
        const ordered = [...sites.values()].sort((left, right) =>
            left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : left.line - right.line);
        output.push(...ordered.filter(site => site.uri === result.textDocument.uri).map(sourceGroup));
        const related = ordered.filter(site => site.uri !== result.textDocument.uri).map(sourceGroup);
        if (related.length) output.push(group(prefix + ':related-sites', 'Related source sites', related, { kind: 'related-sites' }));
        if (unlocated.length) output.push(group(prefix + ':unlocated', 'Other obligations', unlocated, { kind: 'unlocated' }));
        if (!result.obligations.length) {
            output.push(leaf(prefix + ':empty', 'No obligations were returned for this document.'));
        }
        return output;
    }

    function publishDocuments() {
        const documents = visibleDocuments();
        if (!documents.length) { message('Open a local Clef document to inspect its obligations.'); return; }
        if (!client) { message('Lattice server is not connected.'); return; }
        if (!supported()) { message('This server does not advertise clefProofs v1.'); return; }
        const files = documents.map(document => {
            const uri = document.uri.toString();
            const key = documentKey(uri);
            const snapshot = currentProofs(document) ? documentSnapshots.get(uri) : undefined;
            if (snapshot?.tree) return snapshot.tree;
            const children = snapshot ? project(snapshot.result)
                : [leaf(key + ':message', documentErrors.get(uri) ?? 'Refreshing source obligations…')];
            const label = decodeURIComponent(new URL(uri).pathname.split('/').pop());
            const file = group(key, label, children, { tooltip: uri });
            if (snapshot) snapshot.tree = file;
            return file;
        });
        if (files.length !== rows.length || files.some((file, index) => file !== rows[index])) publish(files);
    }

    const provider = {
        onDidChangeTreeData: changed.event,
        getChildren: element => element ? element.children ?? [] : rows,
        getParent(element) {
            const find = siblings => {
                for (const sibling of siblings) {
                    if (sibling.children?.includes(element)) return sibling;
                    const parent = sibling.children && find(sibling.children);
                    if (parent) return parent;
                }
                return undefined;
            };
            return find(rows);
        },
        getTreeItem(element) {
            const item = new vscode.TreeItem(element.label, element.children
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None);
            item.id = element.id;
            item.description = element.description;
            // Strings deliberately stay plain: server text is never trusted Markdown.
            item.tooltip = element.tooltip ?? element.label;
            if (element.location) {
                const { uri, range } = element.location;
                const target = vscode.Uri.parse(uri);
                // A location is optional. Do not turn an origin description or command URI into an action.
                if (target.scheme === 'file') {
                    item.command = {
                        command: 'vscode.open', title: 'Open obligation source',
                        arguments: [target, { selection: new vscode.Range(
                            range.start.line, range.start.character, range.end.line, range.end.character) }]
                    };
                }
            }
            return item;
        }
    };

    function updateRefreshProgress() {
        const waiting = !disposed && visibleDocuments().some(document => {
            const pending = pendingRequests.get(document.uri.toString());
            return pending?.token === revision && pending.version === document.version && pending.client === client;
        });
        if (!waiting) {
            const previous = refreshProgress;
            refreshProgress = undefined;
            previous?.finish();
        } else if (!refreshProgress) {
            let finish;
            const done = new Promise(resolve => { finish = resolve; });
            refreshProgress = { finish };
            // Native indeterminate view progress includes the compiler/solver wait.
            // No percentages can be inferred from pending request counts.
            void vscode.window.withProgress({ location: { viewId: 'lattice.proofs' } }, () => done);
        }
    }

    async function refresh(token) {
        if (disposed || token !== revision) return;
        const documents = visibleDocuments();
        if (!documents.length) { message('Open a local Clef document to inspect its obligations.'); return; }
        if (!client) { message('Lattice server is not connected.'); return; }
        if (!supported()) { message('This server does not advertise clefProofs v1.'); return; }
        const requestingClient = client;
        await Promise.all(documents.map(async document => {
            if (currentProofs(document)) return;
            const uri = document.uri.toString();
            const version = document.version;
            const pending = pendingRequests.get(uri);
            if (pending?.token === token && pending.version === version && pending.client === requestingClient) {
                return pending.work;
            }
            const request = { token, version, client: requestingClient, work: undefined };
            pendingRequests.set(uri, request);
            updateRefreshProgress();
            const current = () => !disposed && token === revision && client === requestingClient &&
                !document.isClosed && document.version === version && pendingRequests.get(uri) === request;
            request.work = (async () => {
                try {
                    const result = await requestingClient.sendRequest('clef/proofs', { textDocument: { uri, version } });
                    if (current()) {
                        const validated = validateResponse(result, uri, version);
                        const snapshot = { result: validated, token, client: requestingClient };
                        documentSnapshots.set(uri, snapshot);
                        documentErrors.delete(uri);
                        publishDocuments();
                    }
                } catch (error) {
                    if (current()) {
                        documentErrors.set(uri, 'Proof obligations unavailable: ' + (error.message ?? String(error)));
                        publishDocuments();
                    }
                } finally {
                    // A late completion belongs to its original check/client;
                    // it cannot evict a newer request for the same document.
                    if (pendingRequests.get(uri) === request) pendingRequests.delete(uri);
                    updateRefreshProgress();
                }
            })();
            return request.work;
        }));
    }

    function selectEditor() {
        if (disposed) return;
        updateRefreshProgress();
        publishDocuments();
        clearTimeout(timer);
        const token = revision;
        timer = setTimeout(() => { void refresh(token); }, 75);
    }

    function invalidate() {
        if (disposed) return;
        ++revision;
        documentSnapshots.clear();
        documentErrors.clear();
        pendingRequests.clear();
        updateRefreshProgress();
        clearTimeout(timer);
        publishDocuments();
        const token = revision;
        timer = setTimeout(() => { void refresh(token); }, 75);
    }

    function detachClient() {
        notification?.dispose();
        notification = undefined;
        client = undefined;
        invalidate();
    }

    const view = vscode.window.createTreeView('lattice.proofs', { treeDataProvider: provider });
    const subscriptions = [
        view,
        vscode.languages.registerCodeLensProvider({ scheme: 'file', language: 'clef' }, lensProvider),
        vscode.commands.registerCommand('lattice.revealProofsAtSource', revealSource),
        vscode.commands.registerCommand('lattice.refreshProofs', invalidate),
        vscode.commands.registerCommand('lattice.expandAllProofs', expandAll),
        vscode.commands.registerCommand('lattice.collapseAllProofs', collapseAll),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('lattice.proofs.showAnnotations') ||
                event.affectsConfiguration('lattice.proofs.display')) {
                lensesChanged.fire(undefined);
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(selectEditor),
        vscode.window.onDidChangeVisibleTextEditors(selectEditor),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === 'clef' && event.document.uri.scheme === 'file') invalidate();
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            if (document.languageId === 'clef') invalidate();
        })
    ];
    const api = {
        attachClient(next) {
            if (disposed) return;
            detachClient();
            client = next;
            if (supported()) notification = client.onNotification('clef/proofsChanged', invalidate);
            invalidate();
        },
        detachClient,
        dispose() {
            if (disposed) return;
            disposed = true;
            ++revision;
            clearTimeout(timer);
            pendingRequests.clear();
            updateRefreshProgress();
            notification?.dispose();
            for (const disposable of subscriptions) disposable.dispose();
            changed.dispose();
            lensesChanged.dispose();
        }
    };
    context.subscriptions.push(api);
    invalidate();
    return api;
}

module.exports = { createProofView };
