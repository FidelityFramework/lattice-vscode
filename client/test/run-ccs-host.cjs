'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prepareDemo } = require('../scripts/prepare-demo.cjs');
const { prepareToml } = require('../scripts/prepare-toml.cjs');

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Use Node.js 22 or later.');
const extension = path.resolve(__dirname, '..');
const code = process.argv[2] ?? process.env.LATTICE_CODE ?? 'code';
const companion = prepareToml({ code });
for (const required of ['node_modules/vscode-languageclient/package.json', 'syntaxes/clef.json']) {
    if (!fs.existsSync(path.join(extension, required))) {
        throw new Error('Missing ' + required + '; prepare the client dependencies and grammar first.');
    }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ccs-host-'));
const demo = prepareDemo({
    output: path.join(root, 'workspace'),
    composer: process.env.LATTICE_COMPOSER_ROOT,
    server: process.env.LATTICE_SERVER_DLL,
    platform: process.env.LATTICE_PLATFORM_PROJECT,
    dotnet: process.env.LATTICE_DOTNET,
    solver: process.env.LATTICE_SOLVER
});
fs.writeFileSync(path.join(root, 'demo.json'), JSON.stringify(demo, null, 2));
fs.writeFileSync(path.join(root, 'companion.json'), JSON.stringify(companion, null, 2));
fs.appendFileSync(demo.tomlConfiguration, '\n[schema]\nenabled = false\n');
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
    '--extensionTestsPath=' + path.join(__dirname, 'ccs-host-smoke.cjs'),
    '--user-data-dir=' + path.join(root, 'user-data'),
    '--extensions-dir=' + companion.extensionsDir,
    '--wait', '--disable-workspace-trust', '--disable-updates', '--skip-welcome',
    '--skip-release-notes', '--disable-gpu',
    ...(process.env.LATTICE_TEST_OZONE || process.platform === 'linux'
        ? ['--ozone-platform=' + (process.env.LATTICE_TEST_OZONE || 'headless')] : []),
    demo.workspace
];
const env = { ...process.env, LATTICE_CCS_HOST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
console.log('Real CCS extension-host profile and evidence: ' + root);
const output = fs.openSync(path.join(root, 'host.log'), 'w');
const child = spawn(code, args, {
    env, stdio: ['ignore', output, output], detached: process.platform !== 'win32'
});
fs.closeSync(output);
let timedOut = false;
const timeout = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') child.kill();
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
}, 180000);
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
