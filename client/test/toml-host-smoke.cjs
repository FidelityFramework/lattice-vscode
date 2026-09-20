'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');

async function until(label, predicate, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw new Error('Timed out waiting for ' + label);
}

async function run() {
    const root = process.env.LATTICE_TOML_HOST_ROOT;
    assert.ok(root, 'Use node test/run-toml-host.cjs.');
    const companion = JSON.parse(fs.readFileSync(path.join(root, 'companion.json'), 'utf8'));
    const lattice = vscode.extensions.getExtension('lattice-local.lattice-clef');
    const toml = vscode.extensions.getExtension(companion.extensionId);
    assert.ok(lattice && toml, 'The development client and isolated companion are loaded.');
    assert.equal(toml.packageJSON.version, companion.version);
    assert.equal(path.resolve(toml.extensionPath), companion.extensionPath);
    const uri = vscode.Uri.file(path.join(root, 'workspace/Smoke.fidproj'));
    assert.equal(vscode.workspace.getConfiguration('lattice', uri).get('server.command'), '',
        'This TOML gate must not start CCS.');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    assert.equal(document.languageId, 'toml', '.fidproj retains the standard TOML language ID.');
    await lattice.activate();
    await toml.activate();

    const tokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', uri);
    fs.writeFileSync(path.join(root, 'syntax-tokens.json'), JSON.stringify(tokens, null, 2));
    assert.ok(Array.isArray(tokens) && tokens.length > 0);
    assert.match(JSON.stringify(tokens), /source\.toml/, 'Actual companion grammar tokenizes .fidproj.');
    for (const scope of ['comment.line.number-sign.toml', 'support.type.property-name.toml',
        'string.quoted.single.basic.line.toml', 'constant.numeric.integer.toml',
        'constant.language.boolean.toml', 'constant.other.time.datetime.offset.toml',
        'meta.table.inline.toml', 'meta.array.toml', 'meta.array.table.toml']) {
        assert.ok(tokens.some(token => token.t.split(' ').includes(scope)), 'Native grammar contains scope: ' + scope);
    }
    assert.equal(vscode.workspace.getConfiguration('workbench', uri).get('colorTheme'), 'Dark Modern');
    const keyToken = tokens.find(token => token.c === 'name');
    const stringToken = tokens.find(token => token.c === '"TomlEditor"');
    assert.notEqual(keyToken.r.dark_modern, stringToken.r.dark_modern,
        'The built-in Dark Modern theme distinguishes key and string scopes.');

    const formatEdits = await until('TOML formatting provider', async () => {
        const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider',
            uri, { tabSize: 4, insertSpaces: true });
        return edits?.length ? edits : undefined;
    });
    const formatting = new vscode.WorkspaceEdit();
    formatting.set(uri, formatEdits);
    assert.equal(await vscode.workspace.applyEdit(formatting), true);
    const formatted = document.getText();
    assert.ok(formatted.includes('name = "TomlEditor"'), 'The native TOML formatter normalizes key/value spacing.');
    fs.writeFileSync(path.join(root, 'formatted.fidproj'), formatted);

    async function replace(text) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
        assert.equal(await vscode.workspace.applyEdit(edit), true);
    }
    await replace('[package]\nname = "unterminated\n');
    const diagnostic = await until('native TOML parse diagnostic', () =>
        vscode.languages.getDiagnostics(uri).find(d => d.severity === vscode.DiagnosticSeverity.Error));
    assert.ok(diagnostic.message.length > 0);
    assert.ok(diagnostic.range.start.line >= 0 && diagnostic.range.end.line < document.lineCount);
    const diagnosticEvidence = {
        source: diagnostic.source, code: diagnostic.code, message: diagnostic.message, range: diagnostic.range
    };
    fs.writeFileSync(path.join(root, 'parse-diagnostic.json'), JSON.stringify(diagnosticEvidence, null, 2));
    await replace(formatted);
    await until('parse diagnostic clears after correction', () => vscode.languages.getDiagnostics(uri)
        .every(d => d.severity !== vscode.DiagnosticSeverity.Error));

    // Observe schema-free key suggestions from this native provider. We do not
    // create a .fidproj schema or claim project-key knowledge when none is returned.
    const keyOffset = formatted.indexOf('name') + 2;
    const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
        uri, document.positionAt(keyOffset));
    const keySuggestions = (completion?.items ?? []).filter(item =>
        item.kind === vscode.CompletionItemKind.Property || item.kind === vscode.CompletionItemKind.Field)
        .map(item => typeof item.label === 'string' ? item.label : item.label.label);
    const completionEvidence = {
        schemaEnabled: false, probe: 'name key within [package]', keySuggestions,
        projectSchemaCompletion: 'Pending a compiler-owned .fidproj schema.'
    };
    fs.writeFileSync(path.join(root, 'completion.json'), JSON.stringify(completionEvidence, null, 2));
    assert.equal(document.languageId, 'toml');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(toml.extensionPath, 'package.json')))
        .digest('hex'), companion.manifestSha256);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({
        passed: true, vscode: vscode.version, companion, languageId: document.languageId,
        scope: 'Actual TOML grammar, syntax diagnostics and formatter on .fidproj; no CCS check or invented project schema.',
        diagnostic: diagnosticEvidence, completion: completionEvidence
    }, null, 2));
    console.log('Real TOML Extension Development Host smoke passed.');
}

module.exports = { run: async () => {
    try { await run(); }
    catch (error) {
        const root = process.env.LATTICE_TOML_HOST_ROOT;
        if (root) fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: false, error: error.stack }, null, 2));
        throw error;
    }
} };
