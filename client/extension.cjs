'use strict';

// Lifecycle and transport only. Semantic features are registered by the LSP
// library according to the server's capabilities and use its results unchanged.
function createController(vscode, LanguageClient, initializationTimeoutMs = 30000, proofView) {
    let client;
    let watcher;
    let disposed = false;
    let pending = Promise.resolve();
    let cancelStart;
    const cancelled = Symbol('superseded server startup');

    const report = error => { void vscode.window.showErrorMessage(`Lattice: ${error.message ?? error}`); };

    async function stop() {
        proofView?.detachClient();
        const previous = client;
        client = undefined;
        try {
            if (previous) await previous.dispose();
        } finally {
            watcher?.dispose();
            watcher = undefined;
        }
    }

    async function restart() {
        await stop();
        if (disposed || !vscode.workspace.isTrusted) return;

        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length !== 1 || folders[0].uri.scheme !== 'file') {
            void vscode.window.showInformationMessage('Lattice currently requires one local workspace folder.');
            return;
        }
        const folder = folders[0];
        const config = vscode.workspace.getConfiguration('lattice', folder.uri);
        const command = config.get('server.command', '');
        const args = config.get('server.args', []);
        if (command === '') return;
        if (typeof command !== 'string' || command.trim() === '' ||
            !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
            throw new Error('server.command must be an executable and server.args an array of strings.');
        }

        watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, '**/*.{clef,fidproj}'));
        let timer;
        try {
            client = new LanguageClient('lattice', 'Lattice', {
                command,
                args: [...args],
                options: { cwd: folder.uri.fsPath, shell: false }
            }, {
                workspaceFolder: folder,
                documentSelector: [{
                    scheme: 'file', language: 'clef',
                    pattern: new vscode.RelativePattern(folder, '**/*.clef')
                }],
                synchronize: { fileEvents: watcher }
            });
            const interrupted = new Promise((_, reject) => {
                cancelStart = () => reject(cancelled);
                timer = setTimeout(() => reject(new Error('Server initialization timed out after 30 seconds.')), initializationTimeoutMs);
            });
            await Promise.race([client.start(), interrupted]);
            proofView?.attachClient(client);
        } catch (error) {
            // v9 can reject dispose when startup failed or is still pending. Its
            // Node client still tears down the owned process in that path.
            try { await stop(); } catch { /* Preserve the original launch failure. */ }
            throw error;
        } finally {
            clearTimeout(timer);
            cancelStart = undefined;
        }
    }

    function scheduleRestart() {
        // Serialize starts/stops, including configuration changes during startup.
        cancelStart?.();
        pending = pending.then(restart).catch(error => {
            if (error !== cancelled && !disposed) report(error);
        });
        return pending;
    }

    return {
        async activate(context) {
            context.subscriptions.push(
                vscode.commands.registerCommand('lattice.restartServer', scheduleRestart),
                vscode.workspace.onDidChangeConfiguration(event => {
                    if (event.affectsConfiguration('lattice.server')) void scheduleRestart();
                }),
                vscode.workspace.onDidChangeWorkspaceFolders(() => { void scheduleRestart(); })
            );
            await scheduleRestart();
        },
        async dispose() {
            disposed = true;
            cancelStart?.();
            await pending;
            await stop();
        }
    };
}

let controller;
let proofView;
let proofDisplay;
async function activate(context) {
    const vscode = require('vscode');
    proofDisplay = require('./proof-display.cjs').createProofDisplay(vscode, context);
    proofView = require('./proof-view.cjs').createProofView(vscode, context);
    controller = createController(vscode, require('vscode-languageclient/node').LanguageClient, 30000, proofView);
    await controller.activate(context);
}
async function deactivate() {
    await controller?.dispose();
    proofView?.dispose();
    proofDisplay?.dispose();
    proofView = undefined;
    proofDisplay = undefined;
    controller = undefined;
}

module.exports = { activate, deactivate, createController };
