'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prepareToml } = require('../scripts/prepare-toml.cjs');

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Use Node.js 22 or later.');
const extension = path.resolve(__dirname, '..');
const code = process.argv[2] ?? process.env.LATTICE_CODE ?? 'code';
const companion = prepareToml({ code });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-toml-host-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
fs.writeFileSync(path.join(root, 'companion.json'), JSON.stringify(companion, null, 2));
fs.writeFileSync(path.join(workspace, '.taplo.toml'), 'include = ["**/*.toml", "**/*.fidproj"]\n\n[schema]\nenabled = false\n');
fs.writeFileSync(path.join(workspace, 'Smoke.fidproj'), `# Syntax-only TOML specimen, not a CCS project schema.
[package]
name="TomlEditor"
version="0.1.0"

[example]
retries=3
enabled=true
started=1979-05-27T07:32:00Z
options={ mode="fast", size=2 }
sources=["Main.clef"]

[[example.nodes]]
name="first"
`);
fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
    'lattice.server.command': '',
    '[toml]': { 'editor.defaultFormatter': companion.extensionId },
    'evenBetterToml.schema.enabled': false,
    'evenBetterToml.schema.catalogs': [],
    'workbench.startupEditor': 'none',
    'workbench.colorTheme': 'Dark Modern'
}, null, 2));
const userSettings = path.join(root, 'user-data/User/settings.json');
fs.mkdirSync(path.dirname(userSettings), { recursive: true });
fs.writeFileSync(userSettings, JSON.stringify({
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'extensions.autoUpdate': false,
    'update.mode': 'none'
}, null, 2));
const args = [
    '--extensionDevelopmentPath=' + extension,
    '--extensionTestsPath=' + path.join(__dirname, 'toml-host-smoke.cjs'),
    '--user-data-dir=' + path.join(root, 'user-data'),
    '--extensions-dir=' + companion.extensionsDir,
    '--wait', '--disable-workspace-trust', '--disable-updates', '--skip-welcome',
    '--skip-release-notes', '--disable-gpu',
    ...(process.env.LATTICE_TEST_OZONE || process.platform === 'linux'
        ? ['--ozone-platform=' + (process.env.LATTICE_TEST_OZONE || 'headless')] : []),
    workspace
];
const env = { ...process.env, LATTICE_TOML_HOST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
console.log('Isolated TOML extension-host profile and evidence: ' + root);
const output = fs.openSync(path.join(root, 'host.log'), 'w');
const child = spawn(code, args, { env, stdio: ['ignore', output, output], detached: process.platform !== 'win32' });
fs.closeSync(output);
let timedOut = false;
const timeout = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') child.kill();
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
}, 90000);
child.on('error', error => {
    clearTimeout(timeout);
    console.error(error.message);
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    clearTimeout(timeout);
    const resultPath = path.join(root, 'result.json');
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : undefined;
    const passed = code === 0 && result?.passed;
    console.log(fs.readFileSync(path.join(root, 'host.log'), 'utf8'));
    if (result?.error) console.error(result.error);
    console.log(passed ? 'PASS: ' + resultPath :
        'FAIL: code=' + code + ', signal=' + signal + ', timeout=' + timedOut + '; inspect ' + root);
    process.exitCode = passed ? 0 : 1;
});
