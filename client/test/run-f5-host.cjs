'use strict';

// Exercise VS Code's real debug launcher inside an already-running parent app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prepareDemo } = require('../scripts/prepare-demo.cjs');
const { prepareToml } = require('../scripts/prepare-toml.cjs');

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Use Node.js 22 or later.');
const client = path.resolve(__dirname, '..');
const code = process.argv[2] ?? process.env.LATTICE_CODE ?? 'code';
const companion = prepareToml({ code });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-f5-host-'));
const demo = prepareDemo({ output: path.join(root, 'workspace'),
    composer: process.env.LATTICE_COMPOSER_ROOT, server: process.env.LATTICE_SERVER_DLL,
    platform: process.env.LATTICE_PLATFORM_PROJECT, dotnet: process.env.LATTICE_DOTNET,
    solver: process.env.LATTICE_SOLVER });
fs.appendFileSync(demo.tomlConfiguration, '\n[schema]\nenabled = false\n');
fs.writeFileSync(path.join(root, 'inputs.json'), JSON.stringify({ client, demo, companion }, null, 2));
const harness = path.join(root, 'parent-extension');
fs.mkdirSync(harness);
fs.writeFileSync(path.join(harness, 'package.json'), JSON.stringify({
    name: 'lattice-f5-test-parent', publisher: 'lattice-test', version: '0.0.0',
    engines: { vscode: '^1.90.0' }, main: 'extension.cjs'
}));
fs.writeFileSync(path.join(harness, 'extension.cjs'), 'exports.activate = () => {};\n');
const userSettings = path.join(root, 'user-data/User/settings.json');
fs.mkdirSync(path.dirname(userSettings), { recursive: true });
fs.writeFileSync(userSettings, JSON.stringify({
    'files.associations': { '*.clef': 'fsharp' },
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off',
    'extensions.autoUpdate': false, 'update.mode': 'none', 'workbench.startupEditor': 'none'
}, null, 2));
const env = { ...process.env, LATTICE_F5_HOST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
const ozone = process.env.LATTICE_TEST_OZONE || (process.platform === 'linux' ? 'headless' : undefined);
const args = [
    '--extensionDevelopmentPath=' + harness,
    '--extensionTestsPath=' + path.join(__dirname, 'f5-parent-smoke.cjs'),
    '--user-data-dir=' + path.join(root, 'user-data'),
    '--extensions-dir=' + path.join(root, 'normal-extensions'),
    '--wait', '--disable-workspace-trust', '--disable-updates', '--skip-welcome',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--skip-release-notes', '--disable-gpu', ...(ozone ? ['--ozone-platform=' + ozone] : []), client
];
console.log('Actual F5 parent/child host evidence: ' + root);
const output = fs.openSync(path.join(root, 'host.log'), 'w');
const child = spawn(code, args, { env, stdio: ['ignore', output, output], detached: process.platform !== 'win32' });
fs.closeSync(output);
const timeout = setTimeout(() => {
    if (process.platform === 'win32') child.kill();
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
}, 150000);
child.on('error', error => { clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
    clearTimeout(timeout);
    const resultPath = path.join(root, 'result.json');
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : undefined;
    const passed = code === 0 && result?.passed;
    console.log(fs.readFileSync(path.join(root, 'host.log'), 'utf8'));
    if (result?.error) console.error(result.error);
    console.log(passed ? 'PASS: ' + resultPath : 'FAIL: code=' + code + ', signal=' + signal + '; inspect ' + root);
    process.exitCode = passed ? 0 : 1;
});
