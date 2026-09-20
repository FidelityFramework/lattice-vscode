'use strict';

// Selected-platform source declarations through the real CCS/LSP project path.
// Source and exact diagnostic expectations are shared with CCS.Editor gates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createMessageConnection } = require('vscode-jsonrpc/node');

function position(text, index) {
    const prefix = text.slice(0, index);
    return { line: prefix.split('\n').length - 1, character: prefix.length - prefix.lastIndexOf('\n') - 1 };
}

async function run(startupOnly) {
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Use Node.js 22 or later.');
    const composer = path.resolve(process.env.LATTICE_COMPOSER_ROOT ?? path.join(__dirname, '../../../Composer'));
    const fixture = path.join(composer, 'tests/Fixtures/ProgramLifetime');
    const server = path.resolve(process.env.LATTICE_SERVER_DLL ?? path.join(composer, 'src/Lattice.Server/bin/Debug/net10.0/Lattice.Server.dll'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-program-lifetime-lsp-'));
    for (const name of ['Names.clef', 'Platform.clef', 'Main.clef', 'Platform.fidproj', 'App.fidproj', 'Cases.json', 'Startup.clef', 'Startup.fidproj'])
        fs.copyFileSync(path.join(fixture, name), path.join(root, name));
    const namesFile = path.join(root, 'Names.clef');
    const platformFile = path.join(root, 'Platform.clef');
    const names = fs.readFileSync(namesFile, 'utf8');
    const platform = fs.readFileSync(platformFile, 'utf8');
    const namesUri = pathToFileURL(namesFile).href;
    const platformUri = pathToFileURL(platformFile).href;
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const assemblies = Object.fromEntries(['Lattice.Server.dll', 'CCS.Editor.dll', 'Clef.Compiler.Service.dll']
        .map(name => [name, hash(path.join(path.dirname(server), name))]));
    const notifications = [];
    const evidence = { server, assemblies, node: process.version, startupOnly, cases: [], notifications,
        scope: 'Selected platform declaration diagnostics and provenance through real CCS/LSP; no native image or proof-discharge claim.' };
    console.log('Program-lifetime LSP evidence: ' + root);
    const log = fs.openSync(path.join(root, 'server.log'), 'w');
    const project = startupOnly ? 'Startup.fidproj' : 'App.fidproj';
    const child = spawn(process.env.LATTICE_DOTNET ?? 'dotnet', [server, '--project', path.join(root, project)],
        { stdio: ['pipe', 'pipe', log] });
    fs.closeSync(log);
    const connection = createMessageConnection(child.stdout, child.stdin);
    let failure;
    child.on('error', error => { failure = error; });
    child.on('exit', (code, signal) => { failure ??= new Error(`Server exited: code=${code}, signal=${signal}`); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    connection.onNotification('textDocument/publishDiagnostics', value => notifications.push(value));
    connection.onNotification(() => {});
    connection.listen();
    const timeout = setTimeout(() => {
        failure = new Error('Selected-platform LSP gate exceeded 60 seconds.');
        connection.dispose();
        child.kill('SIGKILL');
    }, 60000);
    const versions = new Map();
    async function published(uri) {
        const version = versions.get(uri);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            if (failure) throw failure;
            const publication = notifications.findLast(value => value.uri === uri && value.version === version);
            if (publication) return publication;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('No diagnostic publication: ' + uri + ' version ' + version);
    }
    async function open(uri, text) {
        versions.set(uri, 1);
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'clef', version: 1, text } });
        return published(uri);
    }
    async function change(uri, text) {
        const version = versions.get(uri) + 1;
        versions.set(uri, version);
        await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
        return published(uri);
    }
    const noErrors = publication => assert.deepEqual(publication.diagnostics.filter(row => row.severity === 1), []);
    async function provenance() {
        const results = [];
        for (const [name, line] of [['immutableName', 1], ['mutableName', 2]]) {
            const at = position(platform, platform.lastIndexOf(name));
            const request = { textDocument: { uri: platformUri }, position: at };
            const hover = await connection.sendRequest('textDocument/hover', request);
            assert.equal(hover?.contents.value.split('\n')[0], name + ': string');
            const declaration = await connection.sendRequest('textDocument/hover', {
                textDocument: { uri: namesUri }, position: { line, character: 4 }
            });
            assert.equal(declaration?.contents.value.split('\n')[0], name + ': string');
            assert.equal(declaration.range.start.line, line);
            const definition = await connection.sendRequest('textDocument/definition', request);
            assert.deepEqual(definition, { uri: namesUri, range: declaration.range });
            results.push({ name, hover, declaration, definition });
        }
        return results;
    }
    try {
        const initialized = await connection.sendRequest('initialize', {
            processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {}
        });
        assert.equal(initialized.capabilities.hoverProvider, true);
        await connection.sendNotification('initialized', {});
        if (startupOnly) {
            const file = path.join(root, 'Startup.clef');
            const uri = pathToFileURL(file).href;
            const source = fs.readFileSync(file, 'utf8');
            const query = () => connection.sendRequest('clef/programInitialization', {
                textDocument: { uri, version: versions.get(uri) }
            });
            const settled = result => {
                assert.equal(result.textDocument.version, versions.get(uri));
                assert.equal(result.compilerIdentity, assemblies['Clef.Compiler.Service.dll']);
                assert.equal(result.plan.sourceEntry.name, 'main');
                assert.equal(result.plan.sourceEntry.location.uri, uri);
                assert.deepEqual(result.plan.initializers.map(row => row.binding.name), ['state', 'unused', 'stored']);
                assert.deepEqual(result.plan.initializers.map(row => row.ordinal), [0, 1, 2]);
                assert.deepEqual(result.plan.initializers.filter(row => row.requiresProgramStorage).map(row => row.binding.name), ['state', 'stored']);
                for (const row of result.plan.initializers) {
                    assert.equal(row.hasProgramAuthority, false, 'Source-only checking cannot invent native storage authority.');
                    assert.notEqual(row.binding.nodeId, row.value.nodeId);
                    assert.equal(row.binding.location.uri, uri);
                    assert.equal(row.value.location.uri, uri);
                }
                assert.deepEqual(result.pending, []);
            };
            noErrors(await open(uri, source));
            evidence.startup = await query();
            settled(evidence.startup);
            const opaque = source.replace('let initialize () = state <- true', 'let mutable initialize = fun () -> state <- true');
            noErrors(await change(uri, opaque));
            evidence.startupPending = await query();
            assert.equal(evidence.startupPending.plan, null);
            assert.equal(evidence.startupPending.pending.length, 1);
            const pending = evidence.startupPending.pending[0];
            assert.equal(pending.site.name, 'unused');
            assert.equal(pending.site.location.uri, uri);
            assert.equal(pending.sources.length, 2);
            assert.ok(pending.sources.every(row => row.location.uri === uri));
            assert.equal(pending.reason, 'An indirect initializer call lacks a proved pre-entry dependency boundary.');
            noErrors(await change(uri, source));
            evidence.startupRepair = await query();
            settled(evidence.startupRepair);
            assert.notEqual(evidence.startup.checkGeneration, evidence.startupRepair.checkGeneration);
            assert.equal(fs.readFileSync(file, 'utf8'), source);
        } else {
        noErrors(await open(namesUri, names));
        noErrors(await open(platformUri, platform));
        evidence.initialProvenance = await provenance();
        const renamed = names.replaceAll('constant-vault', 'renamed-image').replaceAll('state-vault', 'renamed-state');
        noErrors(await change(namesUri, renamed));
        evidence.renamedProvenance = await provenance();
        noErrors(await change(namesUri, names));
        for (const item of JSON.parse(fs.readFileSync(path.join(root, 'Cases.json'), 'utf8'))) {
            assert.equal(platform.split(item.before).length, 2, 'The diagnostic replacement has exactly one source site.');
            const marked = platform.replace(item.before, item.after);
            const start = marked.indexOf('«');
            const finish = marked.indexOf('»');
            assert.ok(start >= 0 && finish > start);
            const text = marked.slice(0, start) + marked.slice(start + 1, finish) + marked.slice(finish + 1);
            const publication = await change(platformUri, text);
            const errors = publication.diagnostics.filter(row => row.severity === 1);
            assert.equal(errors.length, 1, JSON.stringify(errors));
            const diagnostic = errors[0];
            assert.equal(diagnostic.code, item.code);
            assert.equal(diagnostic.message, item.message.replace('{platform}', path.basename(root)));
            assert.equal(diagnostic.source, 'CCS');
            assert.deepEqual(diagnostic.range, { start: position(text, start), end: position(text, finish - 1) });
            const repaired = await change(platformUri, platform);
            noErrors(repaired);
            evidence.cases.push({ name: item.name, diagnostic, errorVersion: publication.version,
                repairVersion: repaired.version, provenance: await provenance() });
        }
        }
        assert.equal(fs.readFileSync(namesFile, 'utf8'), names, 'Designation renames remain unsaved.');
        assert.equal(fs.readFileSync(platformFile, 'utf8'), platform, 'Declaration edits remain unsaved.');
        for (const uri of versions.keys()) {
            const seen = notifications.filter(value => value.uri === uri && value.version !== undefined).map(value => value.version);
            assert.ok(seen.every((version, index) => index === 0 || version >= seen[index - 1]), 'Diagnostic versions are monotonic.');
        }
        for (const [name, expected] of Object.entries(assemblies))
            assert.equal(hash(path.join(path.dirname(server), name)), expected, 'Assembly changed during the gate: ' + name);
        await connection.sendRequest('shutdown');
        await connection.sendNotification('exit');
        child.stdin.end();
        evidence.serverExit = await exited;
        assert.deepEqual(evidence.serverExit, { code: 0, signal: null });
        evidence.passed = true;
        console.log(startupOnly
            ? 'PASS compiler-owned startup order, source incidence, pending native facts and unsaved repair'
            : 'PASS selected platform role rename, two exact diagnostics, unsaved repairs and declaration provenance');
    } catch (error) {
        evidence.passed = false;
        evidence.error = error.stack;
        throw error;
    } finally {
        fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
        clearTimeout(timeout);
        connection.dispose();
        child.kill();
    }
}

run(false).then(() => run(true)).catch(error => { console.error(error.stack); process.exitCode = 1; });
