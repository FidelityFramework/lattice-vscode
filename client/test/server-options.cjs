'use strict';

// Real CCS through the built Lattice stdio server. No compiler build, platform
// dependency, solver fixture, or client-owned intrinsic catalogue is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createMessageConnection } = require('vscode-jsonrpc/node');

const prelude = 'module OptionWaypoint\n[<Measure>] type m\n[<Measure>] type s\n';
const entry = '\n[<EntryPoint>]\nlet main _ = ignore selected; 0\n';
const valid = prelude + 'let choose = Option.defaultValue 1<m>\nlet selected = choose (Some 2<m>)\n' +
    'let delayedChoose = Option.defaultWith (fun () -> 3<m>)\nlet delayed = delayedChoose None\n' +
    entry.replace('ignore selected', 'ignore selected; ignore delayed');
const cases = [
    ['defaultValue dimensions', 'CCS8040', 'let selected = «Option.defaultValue 1<m> (Some 2<s>)»'],
    ['defaultValue stored partial', 'CCS8040', 'let choose = Option.defaultValue 1<m>\nlet selected = «choose (Some 2<s>)»'],
    ['defaultValue payload kind', 'CCS8003', 'let selected = «Option.defaultValue 1<m> (Some 2.0<m>)»'],
    ['defaultValue explicit type arity', 'CCS8004', 'let selected = «Option.defaultValue<int<m>, int<s>>»'],
    ['defaultWith dimensions', 'CCS8040', 'let selected = «Option.defaultWith (fun () -> 1<m>) (Some 2<s>)»'],
    ['defaultWith stored partial', 'CCS8040', 'let choose = Option.defaultWith (fun () -> 1<m>)\nlet selected = «choose (Some 2<s>)»'],
    ['defaultWith thunk domain', 'CCS8003', 'let selected = «Option.defaultWith (fun (_: int<m>) -> 1<m>)» None'],
    ['defaultWith explicit type arity', 'CCS8004', 'let selected = «Option.defaultWith<int<m>, int<s>>»'],
    ['fractional measure exponent', 'CCS8048', 'let selected = Option.defaultWith<float<«m^(1/2)»>>'],
    ['nonintegral inferred dimension', 'CCS8041', 'let selected = Option.defaultWith (fun () -> «Math.sqrt 2.0<m>») None']
];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const position = text => {
    const lines = text.split('\n');
    return { line: lines.length - 1, character: lines.at(-1).length };
};

async function run() {
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Use Node.js 22 or later.');
    const composer = path.resolve(process.env.LATTICE_COMPOSER_ROOT ?? path.join(__dirname, '../../../Composer'));
    const server = path.resolve(process.env.LATTICE_SERVER_DLL ??
        path.join(composer, 'src/Lattice.Server/bin/Debug/net10.0/Lattice.Server.dll'));
    fs.accessSync(server);
    const assemblies = Object.fromEntries(fs.readdirSync(path.dirname(server))
        .filter(name => name.endsWith('.dll')).map(name => [name, hash(path.join(path.dirname(server), name))]));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-option-waypoint-'));
    const file = path.join(root, 'Main.clef');
    const project = path.join(root, 'OptionWaypoint.fidproj');
    fs.writeFileSync(file, valid);
    fs.writeFileSync(project, '[package]\nname = "OptionWaypoint"\n[compilation]\ntarget = "library"\n' +
        '[build]\nsources = ["Main.clef"]\noutput_kind = "library"\n');
    console.log('Option editor waypoint evidence: ' + root);
    const log = fs.openSync(path.join(root, 'server.log'), 'w');
    const child = spawn(process.env.LATTICE_DOTNET ?? 'dotnet', [server, '--project', project],
        { stdio: ['pipe', 'pipe', log] });
    fs.closeSync(log);
    const connection = createMessageConnection(child.stdout, child.stdin);
    const notifications = [];
    const evidence = { server, assemblies, node: process.version,
        scope: 'Real CCS hover and diagnostics through LSP; no completion, native execution or proof-discharge claim.',
        cases: [], notifications };
    let failure;
    child.on('error', error => { failure = error; });
    child.on('exit', (code, signal) => { failure ??= new Error(`Server exited: code=${code}, signal=${signal}`); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    connection.onNotification('textDocument/publishDiagnostics', value => notifications.push(value));
    connection.onNotification(() => {});
    connection.listen();
    const uri = pathToFileURL(file).href;
    let version = 1;
    const timeout = setTimeout(() => {
        failure = new Error('Option LSP gate exceeded 90 seconds.');
        connection.dispose();
        child.kill('SIGKILL');
    }, 90000);
    async function published() {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            if (failure) throw failure;
            const publication = notifications.findLast(value => value.uri === uri && value.version === version);
            if (publication) return publication;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('No diagnostic publication for document version ' + version);
    }
    const change = async text => {
        await connection.sendNotification('textDocument/didChange', {
            textDocument: { uri, version: ++version }, contentChanges: [{ text }]
        });
        return published();
    };
    const noErrors = publication => assert.deepEqual(publication.diagnostics.filter(row => row.severity === 1), [],
        'The admitted source has no effective compiler errors.');
    const hover = name => connection.sendRequest('textDocument/hover', {
        textDocument: { uri }, position: position(valid.slice(0, valid.indexOf('let ' + name + ' =') + 5))
    });
    try {
        const initialized = await connection.sendRequest('initialize', {
            processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {}
        });
        assert.equal(initialized.capabilities.hoverProvider, true);
        assert.equal(initialized.capabilities.completionProvider, undefined,
            'Do not claim completion before the compiler-owned scope query is exposed.');
        evidence.capabilities = initialized.capabilities;
        await connection.sendNotification('initialized', {});
        await connection.sendNotification('textDocument/didOpen', {
            textDocument: { uri, languageId: 'clef', version, text: valid }
        });
        noErrors(await published());
        evidence.selectedHover = await hover('selected');
        evidence.partialHover = await hover('choose');
        evidence.delayedHover = await hover('delayed');
        evidence.delayedPartialHover = await hover('delayedChoose');
        assert.match(evidence.selectedHover?.contents.value ?? '', /selected: int<m>/);
        assert.match(evidence.partialHover?.contents.value ?? '', /choose: .*int<m>.*-> int<m>/);
        assert.match(evidence.delayedHover?.contents.value ?? '', /delayed: int<m>/);
        assert.match(evidence.delayedPartialHover?.contents.value ?? '', /delayedChoose: .*int<m>.*-> int<m>/);
        for (const [name, code, markedBody] of cases) {
            const start = markedBody.indexOf('«');
            const finish = markedBody.indexOf('»');
            const prefix = prelude + markedBody.slice(0, start);
            const span = markedBody.slice(start + 1, finish);
            const source = prelude + markedBody.replace('«', '').replace('»', '') + entry;
            const publication = await change(source);
            const errors = publication.diagnostics.filter(row => row.severity === 1);
            assert.equal(errors.length, 1, name + ': one effective compiler error');
            assert.equal(errors[0].source, 'CCS', name);
            assert.equal(errors[0].code, code, name);
            assert.deepEqual(errors[0].range, { start: position(prefix), end: position(prefix + span) }, name);
            evidence.cases.push({ name, version, source, diagnostic: errors[0] });
            fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
            noErrors(await change(valid));
            assert.match((await hover('selected'))?.contents.value ?? '', /selected: int<m>/,
                name + ': unsaved correction restores the measured hover');
            console.log('PASS: ' + name + ' and unsaved correction');
        }
        assert.equal(fs.readFileSync(file, 'utf8'), valid, 'All edits remain unsaved.');
        const versions = notifications.filter(value => value.uri === uri && value.version !== undefined).map(value => value.version);
        assert.ok(versions.every((value, index) => index === 0 || value >= versions[index - 1]),
            'An older diagnostic publication must not replace a newer document version.');
        for (const [name, expected] of Object.entries(assemblies))
            assert.equal(hash(path.join(path.dirname(server), name)), expected, 'Assembly changed during the gate: ' + name);
        await connection.sendRequest('shutdown');
        await connection.sendNotification('exit');
        // Close the client's transport after the exit notification has flushed.
        // Keeping stdin open can leave the server's stream reader waiting at EOF.
        child.stdin.end();
        evidence.serverExit = await exited;
        assert.deepEqual(evidence.serverExit, { code: 0, signal: null }, 'Lattice exits successfully after shutdown.');
        evidence.passed = true;
        console.log('PASS: ' + evidence.cases.length + ' Option diagnostic edits and corrections; ' + path.join(root, 'result.json'));
    } catch (error) {
        evidence.passed = false;
        evidence.error = error.stack;
        throw error;
    } finally {
        fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
        clearTimeout(timeout);
        connection.dispose();
        child.kill();
    }
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
