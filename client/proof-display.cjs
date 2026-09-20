'use strict';

const explicitValues = ['globalValue', 'workspaceValue', 'workspaceFolderValue',
    'globalLanguageValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue'];

function annotationsShown(vscode, uri) {
    const configuration = vscode.workspace.getConfiguration('lattice.proofs', uri);
    const inspected = configuration.inspect?.('showAnnotations');
    const configured = configuration.get('showAnnotations', undefined);
    if (inspected ? explicitValues.some(key => inspected[key] !== undefined) : typeof configured === 'boolean')
        return configured !== false;
    // Preserve an existing Hidden preference until the user operates the new
    // toggle. This compatibility read never rewrites their configuration.
    if (configuration.get('display', undefined) === 'hidden') return false;
    return true;
}

function createProofDisplay(vscode, context) {
    let disposed = false;
    let pending = Promise.resolve();
    const item = vscode.window.createStatusBarItem('lattice.proofs.annotations', vscode.StatusBarAlignment.Right, 20);
    item.name = 'Clef proof links';
    item.command = 'lattice.toggleProofAnnotations';
    const workspace = () => {
        if (vscode.workspace.workspaceFolders?.length !== 1) return;
        const folder = vscode.workspace.workspaceFolders[0];
        if (folder.uri.scheme === 'file') return folder;
    };
    function update() {
        if (disposed) return;
        const folder = workspace();
        if (!folder) { item.hide(); return; }
        const shown = annotationsShown(vscode, folder.uri);
        const state = shown ? 'Shown' : 'Hidden';
        item.text = '$(beaker) Proof links: ' + state;
        item.tooltip = 'Proof links: ' + state + '. Click to ' + (shown ? 'hide' : 'show') +
            ' source proof links. The Clef Proofs sidebar and checking remain available.';
        item.accessibilityInformation = { label: 'Clef proof links: ' + state };
        item.show();
    }
    function toggle() {
        const folder = workspace();
        if (disposed || !folder) return Promise.resolve();
        const action = pending.then(async () => {
            const now = workspace();
            if (disposed || !now || now.uri.toString() !== folder.uri.toString()) return;
            await vscode.workspace.getConfiguration('lattice.proofs', folder.uri)
                .update('showAnnotations', !annotationsShown(vscode, folder.uri), vscode.ConfigurationTarget.WorkspaceFolder);
        });
        // A failed settings write is reported to its caller; subsequent clicks
        // remain usable rather than inheriting the rejected promise.
        pending = action.catch(() => {});
        return action;
    }
    const subscriptions = [
        item,
        vscode.commands.registerCommand('lattice.toggleProofAnnotations', toggle),
        vscode.commands.registerCommand('lattice.selectProofDisplay', toggle),
        vscode.window.onDidChangeActiveTextEditor(update),
        vscode.workspace.onDidChangeWorkspaceFolders(update),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('lattice.proofs.showAnnotations') ||
                event.affectsConfiguration('lattice.proofs.display')) update();
        })
    ];
    const api = { dispose() {
        if (disposed) return;
        disposed = true;
        for (const subscription of subscriptions) subscription.dispose();
    } };
    context.subscriptions.push(api);
    update();
    return api;
}

module.exports = { createProofDisplay, annotationsShown };
