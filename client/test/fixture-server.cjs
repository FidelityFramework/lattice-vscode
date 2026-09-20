'use strict';

// Protocol fixture only: these deliberately artificial results are not CCS facts.
const fs = require('node:fs');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const logPath = process.argv[2];
const documents = new Map();
const record = (direction, method, params) => fs.appendFileSync(logPath,
    JSON.stringify({ pid: process.pid, direction, method, params }) + '\n');
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));

function publish(uri, version) {
    const diagnostics = documents.get(uri)?.includes('bad') ? [{
        range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } },
        severity: 1, code: 'FIXTURE001', source: 'lattice-transport-fixture',
        message: 'Fixture diagnostic; no compiler semantics.'
    }] : [];
    const params = { uri, version, diagnostics };
    record('send', 'textDocument/publishDiagnostics', params);
    void connection.sendNotification('textDocument/publishDiagnostics', params);
}

connection.onRequest((method, params) => {
    record('receive', method, params);
    switch (method) {
        case 'initialize':
            if (process.argv.includes('--silent-initialize')) return new Promise(() => {});
            return {
                capabilities: { textDocumentSync: { openClose: true, change: 1 }, hoverProvider: true },
                serverInfo: { name: 'Lattice transport fixture', version: '1' }
            };
        case 'shutdown': return null;
        case 'textDocument/hover': return documents.get(params.textDocument.uri)?.includes('bad')
            ? { contents: { kind: 'plaintext', value: 'FIXTURE hover; no compiler semantics.' } } : null;
        default: throw new Error(`Unexpected request: ${method}`);
    }
});
connection.onNotification((method, params) => {
    record('receive', method, params);
    switch (method) {
        case 'textDocument/didOpen':
            documents.set(params.textDocument.uri, params.textDocument.text);
            publish(params.textDocument.uri, params.textDocument.version);
            break;
        case 'textDocument/didChange':
            if (params.contentChanges.length !== 1 || params.contentChanges[0].range) {
                throw new Error('Fixture negotiated full document synchronization.');
            }
            documents.set(params.textDocument.uri, params.contentChanges[0].text);
            publish(params.textDocument.uri, params.textDocument.version);
            break;
        case 'textDocument/didClose':
            documents.delete(params.textDocument.uri);
            publish(params.textDocument.uri);
            break;
        case 'exit': process.exit(0);
    }
});
connection.onClose(() => process.exit(0));
connection.listen();
