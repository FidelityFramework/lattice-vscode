'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
    const root = process.env.LATTICE_F5_HOST_ROOT;
    const { client, demo, companion } = JSON.parse(fs.readFileSync(path.join(root, 'inputs.json'), 'utf8'));
    assert.equal(vscode.extensions.getExtension(companion.extensionId), undefined,
        'The already-running parent has no normally installed TOML companion.');
    assert.equal(vscode.workspace.getConfiguration('files').inspect('associations').globalValue['*.clef'], 'fsharp');
    const folder = vscode.workspace.workspaceFolders.find(folder => folder.uri.fsPath === client);
    assert.ok(folder);
    const configurations = vscode.workspace.getConfiguration('launch', folder.uri).get('configurations');
    const launch = configurations.find(config => config.name === 'Lattice: HelloDimensionsProof');
    assert.ok(launch, 'Use the checked-in F5 demo configuration.');
    const replace = value => value.replaceAll('${workspaceFolder}', client).replaceAll('${execPath}', process.execPath)
        .replaceAll(path.join(client, '.demo') + path.sep, demo.workspace + path.sep)
        .replace(new RegExp('^' + path.join(client, '.demo').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), demo.workspace);
    const config = { ...launch, preLaunchTask: undefined, runtimeExecutable: process.execPath,
        args: launch.args.map(replace).concat('--extensionTestsPath=' + path.join(__dirname, 'f5-child-smoke.cjs')),
        env: { LATTICE_F5_HOST_ROOT: root } };
    // The task inputs are prepared once by the outer runner; this gate exercises
    // the actual debug-launch route without rebuilding shared server binaries.
    if (process.env.LATTICE_F5_BASELINE === '1') {
        config.args = config.args.filter(arg => arg !== '--extensionDevelopmentPath=' + companion.extensionPath);
        config.args.push('--extensions-dir=' + companion.extensionsDir);
    }
    fs.writeFileSync(path.join(root, 'resolved-debug-launch.json'), JSON.stringify(config, null, 2));
    assert.equal(await vscode.debug.startDebugging(folder, config), true);
    const resultPath = path.join(root, 'child-result.json');
    const deadline = Date.now() + 110000;
    while (!fs.existsSync(resultPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.debug.stopDebugging();
    assert.ok(fs.existsSync(resultPath), 'The actual F5 child returned its result.');
    const child = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(child.passed, true, child.error);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: true,
        route: 'Existing VS Code parent → vscode.debug.startDebugging → extensionHost child',
        inheritedAssociation: '*.clef=fsharp', normallyInstalledToml: false, child }, null, 2));
}

module.exports = { run: async () => {
    try { await run(); }
    catch (error) {
        fs.writeFileSync(path.join(process.env.LATTICE_F5_HOST_ROOT, 'result.json'),
            JSON.stringify({ passed: false, error: error.stack }, null, 2));
        throw error;
    }
} };
