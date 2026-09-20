'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const { rendererProbe } = require('./renderer-probe.cjs');

async function until(label, predicate, timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for ' + label);
}

async function proofControls(root, document, project) {
    const probe = await rendererProbe(root, 'HelloDimensionsProof');
    const dismissedOnboarding = await probe.evaluate(`(() => {
        const close = document.querySelector('[aria-label="Welcome to Visual Studio Code"] button[aria-label="Close"]');
        if (close) close.click();
        return Boolean(close);
    })()`);
    const inspect = () => probe.evaluate(`(() => {
        const visible = element => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' &&
                rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight &&
                (hit === element || element.contains(hit));
        };
        const point = element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
                text: element.textContent.trim(), label: element.getAttribute('aria-label'), title: element.getAttribute('title') };
        };
        const status = [...document.querySelectorAll('.statusbar-item')].filter(visible)
            .find(element => /Proof links:/.test(element.textContent));
        const actions = [...document.querySelectorAll('.editor-group-container.active .editor-actions .action-label')].filter(visible);
        const action = actions.find(element => /toggle source proof links/i.test(
            (element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('title') || '')));
        const proofHeader = [...document.querySelectorAll('.pane-header')].find(element => /clef proofs/i.test(element.textContent));
        const proofActions = proofHeader ? [...proofHeader.querySelectorAll('.action-label')].filter(visible) : [];
        const namedAction = name => proofActions.find(element =>
            ((element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('title') || '')).toLowerCase().includes(name));
        const proofAction = namedAction('toggle source proof links');
        const expandAction = namedAction('expand all proofs');
        const collapseAction = namedAction('collapse all proofs');
        const proofPane = proofHeader?.closest('.pane');
        return { proofHeader: proofHeader && point(proofHeader), proofAction: proofAction && point(proofAction),
            expandAction: expandAction && point(expandAction), collapseAction: collapseAction && point(collapseAction),
            expandedRows: proofPane?.querySelectorAll('.monaco-list-row[aria-expanded="true"]').length ?? 0,
            proofPaneText: proofPane?.textContent, status: status && point(status), action: action && point(action), actions: actions.map(point) };
    })()`);
    const evidence = { interaction: 'Hit-tested rendered DOM HTMLElement.click()', dismissedOnboarding };
    const waitFor = (label, predicate) => until(label, async () => {
        const state = await inspect();
        fs.writeFileSync(path.join(root, 'proof-controls-current.json'), JSON.stringify(state, null, 2));
        return predicate(state) ? state : undefined;
    }, 15000);
    const shown = () => vscode.workspace.getConfiguration('lattice.proofs', document.uri).get('showAnnotations', true);
    const toggle = async (control, expected) => {
        const hit = await probe.click(control);
        fs.writeFileSync(path.join(root, 'proof-control-click.json'), JSON.stringify(hit, null, 2));
        await until('clicked source-link toggle is applied', () => shown() === expected, 15000);
    };
    try {
        evidence.main = await waitFor('visible Main proof status and editor-title control', state => state.status && state.action);
        await vscode.window.showTextDocument(project);
        evidence.project = await waitFor('visible project-file proof status and editor-title control', state => state.status && state.action);
        await toggle(evidence.project.status, false);
        await vscode.workspace.getConfiguration('workbench').update('statusBar.visible', false, vscode.ConfigurationTarget.Global);
        evidence.hidden = await waitFor('editor control remains discoverable with hidden source links and statusbar', state => !state.status && state.action);
        await vscode.commands.executeCommand('lattice.proofs.focus');
        evidence.hiddenSection = await waitFor('proof section and independent controls remain visible', state =>
            state.proofHeader && state.proofAction && state.expandAction && state.collapseAction);
        await toggle(evidence.hiddenSection.proofAction, true);
        const editorControl = await waitFor('project editor toggle remains reachable', state => state.action);
        await toggle(editorControl.action, false);
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('lattice.proofs.focus');
        const populated = await waitFor('source proof sidebar remains populated while links are hidden', state =>
            state.proofPaneText?.includes('Main.clef') && state.expandAction && state.collapseAction);
        await probe.click(populated.expandAction);
        evidence.expanded = await waitFor('rendered Expand All opens proof drawers', state => state.expandedRows > 0 && state.collapseAction);
        assert.equal(shown(), false, 'Expanding proof drawers does not show source links.');
        await probe.click(evidence.expanded.collapseAction);
        evidence.collapsed = await waitFor('rendered Collapse All closes proof drawers', state => state.expandedRows === 0 && state.proofAction);
        assert.equal(shown(), false, 'Collapsing proof drawers does not show source links.');
        await toggle(evidence.collapsed.proofAction, true);
        await vscode.workspace.getConfiguration('workbench').update('statusBar.visible', true, vscode.ConfigurationTarget.Global);
        evidence.restored = await waitFor('restored proof status reflects shown source links', state => state.status?.text.includes('Shown') && state.action);
        fs.writeFileSync(path.join(root, 'proof-controls-rendered.json'), JSON.stringify(evidence, null, 2));
    } finally { probe.dispose(); }
    await vscode.window.showTextDocument(document);
    return evidence;
}

async function run() {
    const root = process.env.LATTICE_F5_HOST_ROOT;
    const { client, demo, companion } = JSON.parse(fs.readFileSync(path.join(root, 'inputs.json'), 'utf8'));
    const lattice = vscode.extensions.getExtension('lattice-local.lattice-clef');
    const toml = vscode.extensions.getExtension(companion.extensionId);
    assert.ok(lattice && toml, 'F5 must load both explicit local development extensions.');
    assert.equal(path.resolve(lattice.extensionPath), client);
    assert.equal(path.resolve(toml.extensionPath), companion.extensionPath);
    assert.equal(toml.packageJSON.version, companion.version);
    const projectUri = vscode.Uri.file(demo.project);
    const project = await vscode.workspace.openTextDocument(projectUri);
    await vscode.window.showTextDocument(project);
    assert.equal(project.languageId, 'toml');
    await toml.activate();
    const tokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', projectUri);
    assert.ok(tokens.some(token => token.t.includes('support.type.property-name') && token.t.includes('source.toml')));
    assert.ok(tokens.some(token => token.t.includes('string.quoted')));
    fs.writeFileSync(path.join(root, 'f5-project-tokens.json'), JSON.stringify(tokens, null, 2));
    const uri = vscode.Uri.file(demo.main);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    assert.equal(vscode.workspace.getConfiguration('files', uri).inspect('associations').globalValue['*.clef'], 'fsharp');
    assert.equal(document.languageId, 'clef', 'Workspace registration must override the inherited legacy F# association.');
    await lattice.activate();
    const offset = document.getText().indexOf('let velocity') + 6;
    let dimensionalHover;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, document.positionAt(offset));
        const text = (hovers ?? []).flatMap(hover => hover.contents).map(content => typeof content === 'string' ? content : content.value).join('\n')
            .replaceAll('&nbsp;', ' ').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replace(/\\([<>/])/g, '$1');
        if (/velocity:\s*float<\s*m\s*\/\s*s\s*>/.test(text)) { dimensionalHover = text; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(dimensionalHover, 'The actual F5-launched client returns real CCS dimensional hover.');
    const renderedControls = await proofControls(root, document, project);
    const original = document.getText();
    const replace = async (target, text) => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(target.uri, new vscode.Range(target.positionAt(0), target.positionAt(target.getText().length)), text);
        assert.equal(await vscode.workspace.applyEdit(edit), true);
    };
    const code = diagnostic => typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
    const error = id => vscode.languages.getDiagnostics(uri).find(d =>
        d.severity === vscode.DiagnosticSeverity.Error && code(d) === id);
    await replace(document, original.replace('3.0<s>', '3.0<m>'));
    const dimension = await until('actual F5 measure diagnostic', () => error('CCS8040'));
    assert.match(dimension.message, /Measure mismatch/);
    await replace(document, original);
    await until('measure diagnostic clears', () => !error('CCS8040'));

    const units = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(demo.workspace, 'Units.clef')));
    const originalUnits = units.getText();
    const withoutSpeed = originalUnits.replace(/^let speed .*\r?\n?/m, '');
    assert.notEqual(withoutSpeed, originalUnits, 'The known fixture contains its referenced definition.');
    await replace(units, withoutSpeed);
    const unknownName = await until('removing a dependency definition produces unknown-name diagnostic', () => error('CCS8009'));
    assert.match(unknownName.message, /speed/);
    await replace(units, originalUnits);
    await until('restoring dependency definition clears diagnostics', () =>
        !vscode.languages.getDiagnostics(uri).some(d => d.severity === vscode.DiagnosticSeverity.Error));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(demo.server)).digest('hex'), demo.serverSha256);
    fs.writeFileSync(path.join(root, 'child-result.json'), JSON.stringify({ passed: true,
        vscode: vscode.version, lattice: lattice.extensionPath, toml: toml.extensionPath,
        mainLanguage: document.languageId, projectLanguage: project.languageId, dimensionalHover,
        renderedControls,
        dimension: { code: code(dimension), message: dimension.message, range: dimension.range },
        removedDefinition: { code: code(unknownName), message: unknownName.message, range: unknownName.range }
    }, null, 2));
}

module.exports = { run: async () => {
    try { await run(); }
    catch (error) {
        fs.writeFileSync(path.join(process.env.LATTICE_F5_HOST_ROOT, 'child-result.json'),
            JSON.stringify({ passed: false, error: error.stack }, null, 2));
        throw error;
    }
} };
