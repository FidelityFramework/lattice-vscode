'use strict';

// Loaded by VS Code's Extension Development Host, not by node --test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function until(label, predicate, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
    const root = process.env.LATTICE_HOST_SMOKE_ROOT;
    assert.ok(root, 'Use node test/run-host.cjs to provide an isolated test workspace.');
    const logPath = path.join(root, 'protocol.jsonl');
    const transcript = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim()
        .split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const received = method => transcript().filter(row => row.direction === 'receive' && row.method === method);
    const extension = vscode.extensions.getExtension('lattice-local.lattice-clef');
    assert.ok(extension, 'Development extension identity is registered.');
    assert.equal(path.resolve(extension.extensionPath), path.resolve(__dirname, '..'));
    assert.equal(vscode.workspace.isTrusted, true);
    const uri = vscode.Uri.file(path.join(root, 'workspace', 'Smoke.clef'));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    assert.equal(document.languageId, 'clef');
    await extension.activate();
    assert.equal(extension.isActive, true);
    await until('fixture didOpen', () => received('textDocument/didOpen').length === 1);

    const init = received('initialize')[0].params;
    assert.equal(init.rootUri, vscode.Uri.file(path.join(root, 'workspace')).toString());
    assert.equal(init.workspaceFolders.length, 1);
    assert.equal(received('textDocument/didOpen')[0].params.textDocument.text, 'let bad = 1\n');

    // VS Code's internal test command observes the actual registered TextMate
    // tokenizer. Its availability is checked explicitly; no semantic tokens used.
    assert.ok((await vscode.commands.getCommands(false)).includes('_workbench.captureSyntaxTokens'),
        'This host does not expose the syntax-token capture test command.');
    const tokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', uri);
    fs.writeFileSync(path.join(root, 'syntax-tokens.json'), JSON.stringify(tokens, null, 2));
    assert.ok(Array.isArray(tokens) && tokens.length > 0, 'Clef grammar produced syntax tokens.');
    assert.match(JSON.stringify(tokens), /source\.clef/);
    assert.match(JSON.stringify(tokens), /keyword|storage/);

    await until('fixture diagnostic', () => vscode.languages.getDiagnostics(uri)
        .some(diagnostic => diagnostic.code === 'FIXTURE001'));
    const diagnostic = vscode.languages.getDiagnostics(uri).find(item => item.code === 'FIXTURE001');
    assert.equal(diagnostic.source, 'lattice-transport-fixture');
    assert.equal(diagnostic.message, 'Fixture diagnostic; no compiler semantics.');
    assert.deepEqual([diagnostic.range.start.line, diagnostic.range.start.character,
        diagnostic.range.end.line, diagnostic.range.end.character], [0, 4, 0, 7]);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(0, 5));
    const hoverText = hovers.flatMap(hover => hover.contents).map(content =>
        typeof content === 'string' ? content : content.value).join('\n');
    // The language client renders plaintext as escaped MarkdownString content.
    assert.equal(hoverText.replaceAll('&nbsp;', ' '), 'FIXTURE hover; no compiler semantics.');

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'let good = 2\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await until('full unsaved document change', () => received('textDocument/didChange')
        .some(row => row.params.contentChanges[0].text === 'let good = 2\n'));
    await until('diagnostic clearing', () => vscode.languages.getDiagnostics(uri).length === 0);
    const cleared = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(0, 5));
    assert.ok(!cleared || cleared.length === 0, 'Hover reflects the changed document.');

    await document.save();
    // Closing a tab can retain its text model in VS Code's cache. Leaving the
    // registered language deterministically exercises the LSP didClose route.
    await vscode.languages.setTextDocumentLanguage(document, 'plaintext');
    await until('didClose after leaving Clef language mode', () => received('textDocument/didClose').length === 1);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.getConfiguration('lattice', uri).update('server.command', '', vscode.ConfigurationTarget.Workspace);
    await until('shutdown and exit', () => received('shutdown').length === 1 && received('exit').length === 1);

    // Exercise v9's real Starting state: the process exists and receives
    // initialize, but never responds. Disabling the server must cancel startup.
    const config = vscode.workspace.getConfiguration('lattice', uri);
    await config.update('server.args', [path.join(__dirname, 'fixture-server.cjs'), logPath, '--silent-initialize'], vscode.ConfigurationTarget.Workspace);
    await config.update('server.command', process.env.LATTICE_HOST_SMOKE_NODE, vscode.ConfigurationTarget.Workspace);
    const silent = await until('silent fixture initialize', () => received('initialize')[1]);
    await config.update('server.command', '', vscode.ConfigurationTarget.Workspace);
    await until('silent fixture process termination', () => {
        try { process.kill(silent.pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    });
    const allowed = new Set(['initialize', 'initialized', 'textDocument/didOpen', 'textDocument/didChange',
        'textDocument/hover', 'textDocument/didClose', 'workspace/didChangeWatchedFiles', 'shutdown', 'exit', '$/cancelRequest', '$/setTrace']);
    for (const row of transcript().filter(item => item.direction === 'receive')) {
        assert.ok(allowed.has(row.method), `Unexpected protocol method ${row.method}`);
    }
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({
        passed: true, vscode: vscode.version, extension: extension.id,
        scope: 'Real editor/client and fixture transport; no CCS semantic validation.',
        silentInitializationCancelled: true,
        methods: [...new Set(transcript().map(row => row.method))]
    }, null, 2));
    console.log('Lattice Extension Development Host smoke passed (protocol fixture only).');
}

module.exports = { run: async () => {
    try { await run(); }
    catch (error) {
        const root = process.env.LATTICE_HOST_SMOKE_ROOT;
        if (root) fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: false, error: error.stack }, null, 2));
        throw error;
    }
} };
