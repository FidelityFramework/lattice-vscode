'use strict';

// Real LSP server, deterministic gated solver stub: exercises scheduling and
// cancellation only. The stub's "unsat" is not evidence of mathematical validity.
// Run explicitly with Node 22; this harness does not build the server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createMessageConnection, CancellationTokenSource } = require('vscode-jsonrpc/node');
const { prepareDemo } = require('../scripts/prepare-demo.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, predicate, timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result;
        await pause(25);
    }
    throw new Error('Timed out: ' + label);
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-server-scheduling-'));
    console.log('Scheduling evidence: ' + root);
    const solver = path.join(root, 'gated-solver');
    const release = path.join(root, 'release');
    const phaseFile = path.join(root, 'phase');
    const callsFile = path.join(root, 'calls.jsonl');
    fs.writeFileSync(callsFile, '');
    fs.writeFileSync(solver, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const crypto = require('node:crypto');
const root = ${JSON.stringify(root)};
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => text += chunk);
process.stdin.on('end', () => {
    const phase = fs.readFileSync(root + '/phase', 'utf8');
    // ProofDispatch.WriteLineAsync adds exactly one newline to the hashed query.
    const hash = crypto.createHash('sha256').update(text.replace(/\\r?\\n$/, '')).digest('hex');
    fs.appendFileSync(root + '/calls.jsonl', JSON.stringify({ phase, hash, pid: process.pid }) + '\\n');
    const gate = setInterval(() => {
        if (!fs.existsSync(root + '/release')) return;
        clearInterval(gate);
        process.stdout.write('unsat\\n');
    }, 10);
});
`, { mode: 0o755 });
    const demo = prepareDemo({ output: path.join(root, 'workspace'),
        composer: process.env.LATTICE_COMPOSER_ROOT, server: process.env.LATTICE_SERVER_DLL,
        platform: process.env.LATTICE_PLATFORM_PROJECT, dotnet: process.env.LATTICE_DOTNET, solver });
    const stderr = fs.openSync(path.join(root, 'server.log'), 'w');
    const child = spawn(demo.dotnet, [demo.server, '--project', demo.project, '--solver', solver],
        { stdio: ['pipe', 'pipe', stderr] });
    fs.closeSync(stderr);
    const connection = createMessageConnection(child.stdout, child.stdin);
    connection.onNotification(() => {});
    connection.listen();
    const mainUri = pathToFileURL(demo.main).href;
    const unitsPath = path.join(demo.workspace, 'Units.clef');
    const unitsUri = pathToFileURL(unitsPath).href;
    const source = fs.readFileSync(demo.main, 'utf8');
    const evidence = { scope: 'Scheduling only; solver verdicts are deterministic test fixtures.' };
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
    const calls = phase => fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).filter(row => row.phase === phase);
    const gate = phase => { fs.rmSync(release, { force: true }); fs.writeFileSync(phaseFile, phase); };
    const openGate = () => fs.writeFileSync(release, 'go');
    const proofs = (uri, version, cancellation) => connection.sendRequest('clef/proofs',
        { textDocument: { uri, version } }, ...(cancellation ? [cancellation.token] : []));
    const edit = (version, text) => connection.sendNotification('textDocument/didChange', {
        textDocument: { uri: mainUri, version }, contentChanges: [{ text }]
    });
    const settled = () => until('current compiler snapshot', async () => {
        try {
            await connection.sendRequest('textDocument/hover', { textDocument: { uri: mainUri },
                position: { line: 0, character: 0 } });
            return true;
        } catch (error) { if (error.code !== -32801) throw error; }
    });
    const uniqueDispatch = (phase, responses) => {
        const expected = new Set(responses.flatMap(response => response.obligations.map(row => row.queryHash)));
        const observed = calls(phase);
        const counts = Object.fromEntries([...expected].map(hash => [hash, observed.filter(row => row.hash === hash).length]));
        evidence[phase] = { expectedQueries: expected.size, dispatches: observed.length, counts };
        fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
        assert.deepEqual(new Set(observed.map(row => row.hash)), expected, 'Dispatches match the requested query identities.');
        assert.ok(Object.values(counts).every(count => count === 1), phase + ': every distinct query must execute once.');
    };
    try {
        await connection.sendRequest('initialize', { processId: process.pid,
            rootUri: pathToFileURL(demo.workspace).href, capabilities: {} });
        await connection.sendNotification('initialized', {});
        for (const [uri, file] of [[mainUri, demo.main], [unitsUri, unitsPath]])
            await connection.sendNotification('textDocument/didOpen', {
                textDocument: { uri, languageId: 'clef', version: 1, text: fs.readFileSync(file, 'utf8') }
            });
        await settled();
        gate('overlap');
        const overlap = [proofs(mainUri, 1), proofs(unitsUri, 1)];
        await until('two solver slots occupied', () => calls('overlap').length >= 2);
        await pause(100); // Both requests reach the blocked shared-query path.
        openGate();
        const responses = await Promise.all(overlap);
        assert.ok(responses[0].obligations.some(left => responses[1].obligations.some(right => left.queryHash === right.queryHash)),
            'The fixture must expose an actual query shared by both files.');
        uniqueDispatch('overlap', responses);

        await edit(2, source + '\n// scheduling generation two\n');
        await settled();
        gate('caller-cancellation');
        const cancellation = new CancellationTokenSource();
        const canceled = proofs(mainUri, 2, cancellation).then(value => ({ value }), error => ({ error }));
        const survivor = proofs(mainUri, 2);
        const sibling = proofs(unitsUri, 1);
        await until('shared dispatch running before caller cancellation', () => calls('caller-cancellation').length >= 2);
        cancellation.cancel();
        const canceledResult = await Promise.race([canceled, pause(1500).then(() => { throw new Error('Canceled caller did not stop waiting.'); })]);
        assert.ok(canceledResult.error, 'Cancellation stops that caller before shared work finishes.');
        openGate();
        const survivingResponses = await Promise.all([survivor, sibling]);
        assert.ok(survivingResponses.every(response => response.obligations.every(row => row.status.state === 'proved')),
            'Canceling one caller does not cancel the shared solver task.');
        uniqueDispatch('caller-cancellation', survivingResponses);
        cancellation.dispose();

        await edit(3, source + '\n// scheduling generation three\n');
        await settled();
        gate('generation-invalidation');
        const obsolete = proofs(mainUri, 3).then(value => ({ value }), error => ({ error }));
        await until('old generation dispatch running', () => calls('generation-invalidation').length >= 2);
        await edit(4, source.replace('3.0<s>', '3.0<m>'));
        const fresh = proofs(mainUri, 4);
        const obsoleteResult = await obsolete;
        assert.equal(obsoleteResult.error?.code, -32801, 'An edit rejects the old generation response.');
        const current = await fresh;
        assert.equal(current.textDocument.version, 4);
        assert.ok(current.obligations.length > 0 && current.obligations.every(row => row.status.state === 'not-dispatched'),
            'A request during the edit debounce waits for fresh errors; it cannot reuse old proved evidence.');
        evidence.generationInvalidation = { staleCode: obsoleteResult.error.code, version: 4,
            states: [...new Set(current.obligations.map(row => row.status.state))] };
        evidence.passed = true;
        fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
        console.log('PASS: ' + path.join(root, 'result.json'));
    } catch (error) {
        evidence.passed = false;
        evidence.error = error.stack;
        fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
        throw error;
    } finally {
        openGate();
        clearTimeout(timeout);
        connection.dispose();
        child.kill();
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
