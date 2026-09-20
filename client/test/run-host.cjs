'use strict';

// Run with Node 22+: node test/run-host.cjs [path-to-code]
// A fresh profile is created under the OS temp directory and retained for logs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Use Node.js 22 or later.');
const extension = path.resolve(__dirname, '..');
for (const required of ['node_modules/vscode-languageclient/package.json', 'syntaxes/clef.json']) {
    if (!fs.existsSync(path.join(extension, required))) {
        throw new Error(`Missing ${required}. Run npm ci and npm run prepare:grammar in client first.`);
    }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-host-smoke-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'Smoke.clef'), 'let bad = 1\n');
fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'lattice.server.command': process.execPath,
    'lattice.server.args': [path.join(__dirname, 'fixture-server.cjs'), path.join(root, 'protocol.jsonl')],
    'workbench.startupEditor': 'none'
}, null, 2));
const userSettings = path.join(root, 'user-data/User/settings.json');
fs.mkdirSync(path.dirname(userSettings), { recursive: true });
fs.writeFileSync(userSettings, JSON.stringify({
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'extensions.autoUpdate': false,
    'update.mode': 'none'
}, null, 2));
const ozone = process.env.LATTICE_TEST_OZONE ?? (process.platform === 'linux' ? 'headless' : undefined);
const args = [
    `--extensionDevelopmentPath=${extension}`, `--extensionTestsPath=${path.join(__dirname, 'host-smoke.cjs')}`,
    `--user-data-dir=${path.join(root, 'user-data')}`, `--extensions-dir=${path.join(root, 'extensions')}`,
    '--wait', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-gpu',
    ...(ozone ? [`--ozone-platform=${ozone}`] : []), workspace
];
const env = { ...process.env, LATTICE_HOST_SMOKE_ROOT: root, LATTICE_HOST_SMOKE_NODE: process.execPath };
// The installed code CLI needs its normal Electron startup mode.
delete env.ELECTRON_RUN_AS_NODE;
console.log(`Isolated VS Code smoke profile and logs: ${root}`);
const output = fs.openSync(path.join(root, 'host.log'), 'w');
const child = spawn(process.argv[2] ?? 'code', args, { env, stdio: ['ignore', output, output], detached: process.platform !== 'win32' });
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
    console.log(passed ? `PASS: ${resultPath}` : `FAIL: code=${code}, signal=${signal}, timeout=${timedOut}; inspect ${root}`);
    process.exitCode = passed ? 0 : 1;
});
