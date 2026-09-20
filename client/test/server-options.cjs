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
    'let optionalEager = Option.orElse (Some 1<m>) None\n' +
    'let optionalDeferred = Option.orElseWith (fun () -> Some 2<m>) (Some 3<m>)\n' +
    'let optionalChoose = Option.orElse (Some 4<m>)\nlet optionalPartial = optionalChoose None\n' +
    'let optionalDelayedChoose = Option.orElseWith (fun () -> Some 5<m>)\nlet optionalDelayedPartial = optionalDelayedChoose None\n' +
    'let anyOptional = Option.orElse\nlet optionalBare = anyOptional None (Some 6<m>)\n' +
    'let anyDelayedOptional = Option.orElseWith\nlet optionalDelayedBare = anyDelayedOptional (fun () -> Some 7<m>) None\n' +
    'let iterationResult = Option.iter (fun (value: int<m>) -> ignore value) (Some 1<m>)\n' +
    'let iterationAction = Option.iter (fun (value: int<m>) -> ignore value)\nlet iterationPartial = iterationAction None\n' +
    'let anyIteration = Option.iter\nlet iterationBare = anyIteration (fun (value: int<m>) -> ignore value) (Some 2<m>)\n' +
    'let iterationBareSeconds = anyIteration (fun (value: int<s>) -> ignore value) (Some 3<s>)\n' +
    'let foldPartial = Option.fold<int<m>, int<s>> (fun state value -> state) 1<m>\nlet folded = foldPartial (Some 2<s>)\n' +
    'let foldBackPartial = Option.foldBack<int<m>, int<s>> (fun value state -> state) (Some 2<s>)\nlet foldedBack = foldBackPartial 1<m>\n' +
    'let anyFold = Option.fold\nlet anyFoldBack = Option.foldBack\n' +
    'let foldBare = anyFold (fun (state: int<m>) (_: int<s>) -> state) 1<m> (Some 2<s>)\n' +
    'let foldBackBare = anyFoldBack (fun (_: int<s>) (state: int<m>) -> state) (Some 3<s>) foldBare\n' +
    '[<Measure>] type kg\n' +
    'let resultMapPartial = Result.map<int<m>, int<kg>, int<s>> (fun _ -> 1<kg>)\nlet resultMapped = resultMapPartial (Ok 2<m>)\n' +
    'let resultErrorMapped = Result.mapError<int<m>, int<s>, int<kg>> (fun _ -> 1<kg>) (Error 2<s>)\n' +
    'let resultBound = Result.bind<int<m>, int<kg>, int<s>> (fun _ -> Ok 1<kg>) (Ok 2<m>)\n' +
    'let resultDefaulted = Result.defaultValue<int<m>, int<s>> 1<m> (Error 2<s>)\n' +
    'let resultRecover = Result.defaultWith<int<m>, int<s>> (fun error -> error * 1<m> / 1<s>)\nlet resultRecovered = resultRecover (Error 2<s>)\n' +
    'let resultIterated = Result.iter<int<m>, int<s>> (fun value -> ignore value) (Ok 2<m>)\n' +
    'let resultIsOkPredicate = Result.isOk<int<m>, int<s>>\nlet resultIsOk = resultIsOkPredicate (Ok 1<m>)\n' +
    'let resultIsErrorPredicate = Result.isError<int<s>, int<m>>\nlet resultIsError = resultIsErrorPredicate (Error 2<m>)\n' +
    'let nativeSequence = seq { yield 1<m> }\n' +
    'let nestedSequence = seq {\n    let inner = seq { yield true }\n    yield 1<m>\n}\n' +
    'let makeSequence () =\n    let seed = 1<m>\n    seq { yield seed }\nlet capturedSequence = makeSequence ()\n' +
    'let mappedSequence =\n    let threshold = 1<m>\n    let values = seq { yield 2<m> }\n' +
    '    let filtered = Seq.filter (fun value -> value > threshold) values\n' +
    '    Seq.map (fun value -> value + threshold) filtered\n' +
    'let collectedSequence =\n    let tail = seq { yield 3<s> }\n    let values = seq { yield 1<m> }\n' +
    '    let collected = Seq.collect (fun (_: int<m>) -> seq { yield 2<s> }) values\n' +
    '    Seq.append collected tail\n' +
    'let guardedSequence =\n    let mutable observed = 1<m>\n    seq {\n' +
    '        let guardedInner = seq { yield true }\n        observed <- observed + 1<m>\n' +
    '        if observed > 0<m> then\n            yield observed\n' +
    '        let delegated = seq { yield observed }\n        yield! delegated\n    }\n' +
    'let effectOnlySequence =\n    let mutable touched = false\n' +
    '    let empty: seq<unit> = seq { touched <- not touched }\n    empty\n' +
    'let effectfulDelegation =\n    let mutable visits = 1<m>\n    seq {\n' +
    '        yield! (\n            visits <- 2<m>\n            seq { yield visits }\n        )\n    }\n' +
    'let nestedDelegation =\n    let offset = 2<m>\n' +
    '    let projected = Seq.collect (fun (value: int<m>) -> seq { yield value + offset }) (seq { yield 1<m> })\n' +
    '    Seq.append (seq { yield! projected }) (seq { yield offset })\n' +
    'let loopingSequence =\n    let mutable stepValue = 1<m>\n    seq {\n' +
    '        while stepValue < 3<m> do\n            if stepValue > 0<m> then yield stepValue\n' +
    '            stepValue <- stepValue + 1<m>\n    }\n' +
    'let deferredSequence =\n    let evaluationSeed = 4<m>\n    seq {\n' +
    '        let sample = fun () -> evaluationSeed\n        let delayedValue = lazy (evaluationSeed)\n' +
    '        yield sample ()\n        yield Lazy.force delayedValue\n    }\n' +
    'let nestedLocalSequence = seq {\n    let localSeed = 1<m>\n    let mutable localFlag = true\n' +
    '    let localChild = seq {\n        yield localSeed\n        if localFlag then yield localSeed\n    }\n' +
    '    yield! localChild\n}\n' +
    'let countedSequence = seq {\n    for ascending in 1 .. 2 do\n        yield ascending\n' +
    '    for descending = 2 downto 1 do\n        yield descending\n}\n' +
    'let consumedSequence =\n    for item in seq { yield 1<m> } do\n        ignore item\n    ()\n' +
    'let rangeLoop =\n    for index in (-2 .. 2) do ignore index\n    ()\n' +
    'let loopCapture =\n    for index = 1 to 2 do\n        let visit = fun (value: int) -> ignore (index + value)\n        visit 0\n    ()\n' +
    entry.replace('ignore selected', 'ignore selected; ignore delayed; ignore optionalEager; ignore optionalDeferred; ' +
        'ignore optionalPartial; ignore optionalDelayedPartial; ignore optionalBare; ignore optionalDelayedBare; ' +
        'ignore iterationResult; ignore iterationPartial; ignore iterationBare; ignore iterationBareSeconds; ' +
        'ignore folded; ignore foldedBack; ignore foldBare; ignore foldBackBare; ' +
        'ignore resultMapped; ignore resultErrorMapped; ignore resultBound; ' +
        'ignore resultDefaulted; ignore resultRecovered; ignore resultIterated; ignore resultIsOk; ignore resultIsError; ' +
        'ignore nativeSequence; ignore nestedSequence; ignore capturedSequence; ' +
        'ignore mappedSequence; ignore collectedSequence; ignore guardedSequence; ignore effectOnlySequence; ' +
        'ignore effectfulDelegation; ignore nestedDelegation; ' +
        'ignore loopingSequence; ignore deferredSequence; ' +
        'ignore nestedLocalSequence; ignore countedSequence; ignore consumedSequence; ' +
        'ignore rangeLoop; ignore loopCapture');
// Same source contract as Composer/tests/CCS.Editor.Tests/Program.fs. Hidden
// capture parameters must never appear in source declaration/reference hover.
const directCaptures = `module DirectCaptures
[<Measure>] type m
[<Measure>] type s
[<EntryPoint>]
let main _ =
    let offset = 7<m>
    let shift (value: int<m>) = offset + value
    let plain (value: int<m>) = value
    let make () = fun (value: int<m>) -> offset + value
    let shifted = shift 3<m>
    let unchanged = plain 10<m>
    let produced = make () 3<m>
    if shifted = unchanged && produced = 10<m> then 0 else 1
`;
const lexicalMath = [
    ['local Math module', 'module Math =\n    let sin (value: int<m>) = value\nlet selected = Math.sin 2<m>'],
    ['local Math record', 'type Functions = { sin: int<m> -> int<m> }\nlet Math = { sin = fun value -> value }\nlet selected = Math.sin 2<m>']
];
const cases = [
    ['defaultValue dimensions', 'CCS8040', 'let selected = «Option.defaultValue 1<m> (Some 2<s>)»'],
    ['defaultValue stored partial', 'CCS8040', 'let choose = Option.defaultValue 1<m>\nlet selected = «choose (Some 2<s>)»'],
    ['defaultValue payload kind', 'CCS8003', 'let selected = «Option.defaultValue 1<m> (Some 2.0<m>)»'],
    ['defaultValue explicit type arity', 'CCS8004', 'let selected = «Option.defaultValue<int<m>, int<s>>»'],
    ['defaultWith dimensions', 'CCS8040', 'let selected = «Option.defaultWith (fun () -> 1<m>) (Some 2<s>)»'],
    ['defaultWith stored partial', 'CCS8040', 'let choose = Option.defaultWith (fun () -> 1<m>)\nlet selected = «choose (Some 2<s>)»'],
    ['defaultWith thunk domain', 'CCS8003', 'let selected = «Option.defaultWith (fun (_: int<m>) -> 1<m>)» None'],
    ['defaultWith explicit type arity', 'CCS8004', 'let selected = «Option.defaultWith<int<m>, int<s>>»'],
    ['orElse dimensions', 'CCS8040', 'let selected = «Option.orElse (Some 1<m>) (Some 2<s>)»'],
    ['orElse stored partial', 'CCS8040', 'let choose = Option.orElse (Some 1<m>)\nlet selected = «choose (Some 2<s>)»'],
    ['orElse nonoption fallback', 'CCS8003', 'let selected = «Option.orElse 1<m>» None'],
    ['orElseWith dimensions', 'CCS8040', 'let selected = «Option.orElseWith (fun () -> Some 1<m>) (Some 2<s>)»'],
    ['orElseWith stored partial', 'CCS8040', 'let choose = Option.orElseWith (fun () -> Some 1<m>)\nlet selected = «choose (Some 2<s>)»'],
    ['orElseWith thunk domain', 'CCS8003', 'let selected = «Option.orElseWith (fun (_: int<m>) -> Some 1<m>)» None'],
    ['orElseWith nonoption thunk result', 'CCS8003', 'let selected = «Option.orElseWith (fun () -> 1<m>)» None'],
    ['iter nonunit callback result', 'CCS8003', 'let selected = «Option.iter (fun (value: int<m>) -> value)» None'],
    ['iter argument dimension', 'CCS8040', 'let selected = «Option.iter (fun (_: int<m>) -> ()) (Some 1<s>)»'],
    ['iter nonoption input', 'CCS8003', 'let selected = «Option.iter (fun (_: int<m>) -> ()) 1<m>»'],
    ['iter nonfunction callback', 'CCS8003', 'let selected = «Option.iter 1<m>» None'],
    ['fold callback state dimension', 'CCS8040', 'let selected = «Option.fold (fun (state: int<m>) (_: int<s>) -> state) 1<s>» None'],
    ['foldBack callback payload dimension', 'CCS8040', 'let selected = «Option.foldBack (fun (_: int<s>) (state: int<m>) -> state) (Some 2<m>)» 1<m>'],
    ['fold callback result dimension', 'CCS8040', 'let selected = «Option.fold (fun (state: int<m>) (_: int<s>) -> 1<s>)» 1<m> None'],
    ['Result.map success dimension', 'CCS8040', 'let selected = «Result.map (fun (_: int<m>) -> true) (Ok 2<s>: Result<int<s>, bool>)»'],
    ['Result.mapError error dimension', 'CCS8040', 'let selected = «Result.mapError (fun (_: int<m>) -> true) (Error 2<s>: Result<bool, int<s>>)»'],
    ['Result.bind shared error dimension', 'CCS8040', 'let selected = «Result.bind (fun (_: bool) -> (Error 3<m>: Result<bool, int<m>>)) (Error 2<s>: Result<bool, int<s>>)»'],
    ['Result.defaultValue fallback dimension', 'CCS8040', 'let selected = «Result.defaultValue 1<m> (Ok 2<s>: Result<int<s>, bool>)»'],
    ['Result.defaultWith error callback dimension', 'CCS8040', 'let selected = «Result.defaultWith (fun (_: int<s>) -> 1<m>) (Error 2<m>: Result<int<m>, int<m>>)»'],
    ['Result.iter nonunit action', 'CCS8003', 'let selected = «Result.iter (fun (_: bool) -> 3)» (Ok true: Result<bool, bool>)'],
    ['Result.isOk payload dimension', 'CCS8040', 'let selected = «Result.isOk<int<m>, bool> (Ok 3<s>)»'],
    ['Result.isError overapplication', 'CCS8003', 'let selected = «Result.isError (Error (): Result<int<m>, unit>) true»'],
    ['range loop floating bound', 'CCS8003', 'let selected =\n    «for index in 0.0 .. 1 do ignore index»\n    ()'],
    ['range loop Boolean bound', 'CCS8003', 'let selected =\n    «for index in true .. 1 do ignore index»\n    ()'],
    ['range loop measured bound', 'CCS8040', 'let selected =\n    «for index in 1<m> .. 3 do ignore index»\n    ()'],
    ['immutable loop counted assignment', 'CCS8009', 'let selected =\n    for index = 1 to 3 do\n        index <- «9»\n    ()'],
    ['immutable loop range assignment', 'CCS8009', 'let selected =\n    for index in 1 .. 3 do\n        index <- «9»\n    ()'],
    ['CE custom builder', 'CCS8401', 'let builder value = value\nlet selected = builder «{\n    return true\n}»'],
    ['CE seq let bang', 'CCS8401', 'let selected = seq {\n    «let! value = true\n    yield value»\n}'],
    ['CE seq lambda yield', 'CCS8401', 'let selected = seq {\n    let work = fun () -> «yield 1»\n    yield 2\n}'],
    ['CE seq lazy yield', 'CCS8401', 'let selected = seq {\n    let work = lazy («yield 1»)\n    yield 2\n}'],
    ['CE lexical seq', 'CCS8401', 'let seq value = not value\nlet selected = seq «{ yield true }»'],
    ['Sequence mixed yield dimensions', 'CCS8040', 'let selected = seq { yield 1<m>; «yield 2<s>» }'],
    ['Sequence scalar delegation', 'CCS8003', 'let selected = seq { «yield! 1» }'],
    ['Sequence conflicting delegations', 'CCS8040', 'let selected = seq { yield! seq { yield 1<m> }; «yield! seq { yield 2<s> }» }'],
    ['Sequence consumption scalar input', 'CCS8003', 'let selected =\n    «for item in 1 do ()»\n    ()'],
    ['Seq producer callback dimension', 'CCS8040', 'let selected = «Seq.map (fun (value: int<m>) -> value) (seq { yield 1<s> })»'],
    ['Seq producer delegation dimension', 'CCS8040', 'let selected = seq { yield 1<m>; «yield! Seq.append (seq { yield 2<s> }) (seq { yield 3<s> })» }'],
    ['fractional measure exponent', 'CCS8048', 'let selected = Option.defaultWith<float<«m^(1/2)»>>'],
    ['nonintegral inferred dimension', 'CCS8041', 'let selected = Option.defaultWith (fun () -> «Math.sqrt 2.0<m>») None'],
    ['intrinsic Math.sin dimension', 'CCS8040', 'let selected = «Math.sin 1.0<m>»']
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-surface-waypoint-'));
    const file = path.join(root, 'Main.clef');
    const project = path.join(root, 'SurfaceWaypoint.fidproj');
    fs.writeFileSync(file, valid);
    fs.writeFileSync(project, '[package]\nname = "SurfaceWaypoint"\n[compilation]\ntarget = "library"\n' +
        '[build]\nsources = ["Main.clef"]\noutput_kind = "library"\n');
    console.log('Compiler surface editor evidence: ' + root);
    const log = fs.openSync(path.join(root, 'server.log'), 'w');
    const child = spawn(process.env.LATTICE_DOTNET ?? 'dotnet', [server, '--project', project],
        { stdio: ['pipe', 'pipe', log] });
    fs.closeSync(log);
    const connection = createMessageConnection(child.stdout, child.stdin);
    const notifications = [];
    const evidence = { server, assemblies, node: process.version,
        scope: 'Option/Result, integer ranges, direct immutable capture and lexical Math source projections through real CCS/LSP; no completion, native execution or proof-discharge claim.',
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
        failure = new Error('Compiler surface LSP gate exceeded 90 seconds.');
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
    const capturedSequenceHovers = async () => {
        const lines = valid.split('\n');
        const at = (marker, token) => {
            const line = lines.findIndex(text => text.includes(marker));
            assert.ok(line >= 0, marker);
            return { line, character: lines[line].indexOf(token) };
        };
        const hoverAt = (marker, token) => connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: at(marker, token)
        });
        const factory = await hoverAt('let makeSequence', 'makeSequence');
        const result = await hover('capturedSequence');
        const expression = await hoverAt('seq { yield seed }', 'seq');
        const declaration = await hoverAt('let seed', 'seed');
        const captured = await hoverAt('seq { yield seed }', 'seed');
        assert.equal(factory?.contents.value.split('\n')[0], 'makeSequence: unit -> seq<int<m>>');
        assert.equal(result?.contents.value.split('\n')[0], 'capturedSequence: seq<int<m>>');
        assert.equal(expression?.contents.value.split('\n')[0], 'seq<int<m>>',
            'The internal generator formal must not occupy the source seq token.');
        assert.equal(declaration?.contents.value.split('\n')[0], 'seed: int<m>');
        assert.equal(captured?.contents.value.split('\n')[0], 'seed: int<m>');
        assert.equal(declaration.range.start.line, at('let seed', 'seed').line);
        const definition = await connection.sendRequest('textDocument/definition', {
            textDocument: { uri }, position: at('seq { yield seed }', 'seed')
        });
        assert.deepEqual(definition, { uri, range: declaration.range });
        return { version, factory, result, expression, declaration, captured, definition };
    };
    const nestedSequenceHovers = async () => {
        const outer = await hover('nestedSequence');
        const lines = valid.split('\n');
        const line = lines.findIndex(text => text.includes('let inner = seq'));
        assert.ok(line >= 0);
        const inner = await connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: { line, character: lines[line].indexOf('inner') }
        });
        assert.equal(outer?.contents.value.split('\n')[0], 'nestedSequence: seq<int<m>>');
        assert.equal(inner?.contents.value.split('\n')[0], 'inner: seq<bool>');
        return { version, outer, inner };
    };
    const sequenceProducerHovers = async () => {
        const lines = valid.split('\n');
        const at = (marker, token) => {
            const line = lines.findIndex(text => text.includes(marker));
            assert.ok(line >= 0, marker);
            const character = lines[line].indexOf(token);
            assert.ok(character >= 0, token);
            return { line, character };
        };
        const hoverAt = (marker, token) => connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: at(marker, token)
        });
        const results = [];
        for (const [binding, type] of [['mappedSequence', 'seq<int<m>>'], ['collectedSequence', 'seq<int<s>>']]) {
            const result = await hover(binding);
            assert.equal(result?.contents.value.split('\n')[0], binding + ': ' + type);
            results.push({ binding, result });
        }
        const applications = [];
        for (const [operation, finalArgument, type] of [
            ['Seq.filter', ' values', 'seq<int<m>>'], ['Seq.map', ' filtered', 'seq<int<m>>'],
            ['Seq.collect', ' values', 'seq<int<s>>'], ['Seq.append', ' tail', 'seq<int<s>>']
        ]) {
            // Query the full-call separator outside the callee, earlier
            // partial application and final argument token intervals.
            const result = await hoverAt(operation, finalArgument);
            assert.equal(result?.contents.value.split('\n')[0], type,
                operation + ': generated snapshots must not replace the source application result');
            applications.push({ operation, result });
        }
        const declaration = await hoverAt('let threshold', 'threshold');
        const start = at('let threshold', 'threshold');
        assert.equal(declaration?.contents.value.split('\n')[0], 'threshold: int<m>');
        assert.deepEqual(declaration.range, { start, end: { line: start.line, character: start.character + 'threshold'.length } });
        const captures = [];
        for (const operation of ['Seq.filter', 'Seq.map']) {
            const result = await hoverAt(operation, 'threshold');
            assert.equal(result?.contents.value.split('\n')[0], 'threshold: int<m>');
            const definition = await connection.sendRequest('textDocument/definition', {
                textDocument: { uri }, position: at(operation, 'threshold')
            });
            assert.deepEqual(definition, { uri, range: declaration.range });
            captures.push({ operation, result, definition });
        }
        return { version, results, applications, declaration, captures };
    };
    const sequenceOwnershipHovers = async () => {
        const lines = valid.split('\n');
        const at = (marker, token, last = false) => {
            const line = lines.findIndex(text => text.includes(marker));
            assert.ok(line >= 0, marker);
            const character = last ? lines[line].lastIndexOf(token) : lines[line].indexOf(token);
            assert.ok(character >= 0, token);
            return { line, character };
        };
        const hoverAt = (marker, token, last = false) => connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: at(marker, token, last)
        });
        const results = [];
        for (const [binding, type] of [
            ['guardedSequence', 'seq<int<m>>'], ['guardedInner', 'seq<bool>'],
            ['delegated', 'seq<int<m>>'], ['effectOnlySequence', 'seq<unit>']
        ]) {
            const result = await hover(binding);
            assert.equal(result?.contents.value.split('\n')[0], binding + ': ' + type);
            results.push({ binding, result });
        }
        const delegated = await hoverAt('yield! delegated', 'delegated');
        assert.equal(delegated?.contents.value.split('\n')[0], 'delegated: seq<int<m>>');
        const empty = await hoverAt('let empty', 'seq {');
        assert.equal(empty?.contents.value.split('\n')[0], 'seq<unit>');
        const captures = [];
        for (const [token, type, uses] of [
            ['observed', 'int<m>', ['if observed', 'yield observed', 'let delegated']],
            ['touched', 'bool', ['let empty']]
        ]) {
            const declaration = await hoverAt('let mutable ' + token, token);
            const start = at('let mutable ' + token, token);
            assert.equal(declaration?.contents.value.split('\n')[0], token + ': ' + type);
            assert.deepEqual(declaration.range, { start, end: { line: start.line, character: start.character + token.length } });
            for (const marker of uses) {
                const result = await hoverAt(marker, token, true);
                assert.equal(result?.contents.value.split('\n')[0], token + ': ' + type);
                const definition = await connection.sendRequest('textDocument/definition', {
                    textDocument: { uri }, position: at(marker, token, true)
                });
                assert.deepEqual(definition, { uri, range: declaration.range });
                captures.push({ token, marker, result, definition });
            }
        }
        return { version, results, delegated, empty, captures };
    };
    const delegationHovers = async () => {
        const lines = valid.split('\n');
        const at = (marker, token) => {
            const line = lines.findIndex(text => text.includes(marker));
            assert.ok(line >= 0, marker);
            const character = lines[line].indexOf(token);
            assert.ok(character >= 0, token);
            return { line, character };
        };
        const hoverAt = (marker, token) => connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: at(marker, token)
        });
        const results = [];
        for (const binding of ['effectfulDelegation', 'nestedDelegation', 'projected']) {
            const result = await hover(binding);
            assert.equal(result?.contents.value.split('\n')[0], binding + ': seq<int<m>>');
            results.push({ binding, result });
        }
        const effectful = await hoverAt('yield! (', 'yield!');
        assert.equal(effectful?.contents.value.split('\n')[0], 'unit');
        const start = at('yield! (', 'yield!');
        const close = at('        )', ')');
        assert.deepEqual(effectful.range, { start, end: { line: close.line, character: close.character + 1 } });
        const nested = await hoverAt('Seq.append (seq { yield! projected })', 'yield!');
        assert.equal(nested?.contents.value.split('\n')[0], 'unit');
        const operand = await hoverAt('seq { yield visits }', 'seq');
        assert.equal(operand?.contents.value.split('\n')[0], 'seq<int<m>>');
        const composed = await hoverAt('Seq.append (seq { yield! projected })', ' (seq { yield offset })');
        assert.equal(composed?.contents.value.split('\n')[0], 'seq<int<m>>');
        const captures = [];
        for (const [token, declarationMarker, useMarker] of [
            ['visits', 'let mutable visits', 'seq { yield visits }'],
            ['offset', 'let offset', 'let projected']
        ]) {
            const declaration = await hoverAt(declarationMarker, token);
            const captured = await hoverAt(useMarker, token);
            assert.equal(captured?.contents.value.split('\n')[0], token + ': int<m>');
            const definition = await connection.sendRequest('textDocument/definition', {
                textDocument: { uri }, position: at(useMarker, token)
            });
            assert.deepEqual(definition, { uri, range: declaration.range });
            captures.push({ token, declaration, captured, definition });
        }
        return { version, results, effectful, nested, operand, composed, captures };
    };
    const sequenceEvaluationHovers = async () => {
        const lines = valid.split('\n');
        const at = (marker, token) => {
            const line = lines.findIndex(text => text.includes(marker));
            assert.ok(line >= 0, marker);
            const character = lines[line].indexOf(token);
            assert.ok(character >= 0, token);
            return { line, character };
        };
        const hoverAt = (marker, token) => connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: at(marker, token)
        });
        const results = [];
        for (const binding of ['loopingSequence', 'deferredSequence']) {
            const result = await hover(binding);
            assert.equal(result?.contents.value.split('\n')[0], binding + ': seq<int<m>>');
            results.push({ binding, result });
        }
        const loop = await hoverAt('while stepValue', 'while');
        assert.equal(loop?.contents.value.split('\n')[0], 'unit');
        const declaredSample = await hoverAt('let sample', 'sample');
        const calledSample = await hoverAt('yield sample', 'sample');
        assert.equal(declaredSample?.contents.value.split('\n')[0], 'sample: unit -> int<m>');
        assert.equal(calledSample?.contents.value.split('\n')[0], 'sample: unit -> int<m>');
        const captures = [];
        for (const [token, declarationMarker, uses] of [
            ['stepValue', 'let mutable stepValue', ['while stepValue', 'if stepValue']],
            ['evaluationSeed', 'let evaluationSeed', ['let sample', 'let delayedValue']]
        ]) {
            const declaration = await hoverAt(declarationMarker, token);
            for (const marker of uses) {
                const result = await hoverAt(marker, token);
                assert.equal(result?.contents.value.split('\n')[0], token + ': int<m>');
                const definition = await connection.sendRequest('textDocument/definition', {
                    textDocument: { uri }, position: at(marker, token)
                });
                assert.deepEqual(definition, { uri, range: declaration.range });
                captures.push({ token, marker, result, definition });
            }
        }
        return { version, results, loop, declaredSample, calledSample, captures };
    };
    const sequenceContinuationHovers = async () => {
        const lines = valid.split('\n');
        const at = (marker, token) => {
            const line = lines.findIndex(text => text.includes(marker));
            assert.ok(line >= 0, marker);
            const character = lines[line].indexOf(token);
            assert.ok(character >= 0, token);
            return { line, character };
        };
        const hoverAt = (marker, token) => connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: at(marker, token)
        });
        const results = [];
        for (const [binding, type] of [
            ['nestedLocalSequence', 'seq<int<m>>'], ['countedSequence', 'seq<int>'], ['consumedSequence', 'unit']
        ]) {
            const result = await hover(binding);
            assert.equal(result?.contents.value.split('\n')[0], binding + ': ' + type);
            results.push({ binding, result });
        }
        const child = await hoverAt('let localChild', 'localChild');
        assert.equal(child?.contents.value.split('\n')[0], 'localChild: seq<int<m>>');
        const captures = [];
        for (const [token, type, declarationMarker, uses] of [
            ['localSeed', 'int<m>', 'let localSeed', ['yield localSeed', 'if localFlag']],
            ['localFlag', 'bool', 'let mutable localFlag', ['if localFlag']]
        ]) {
            const declaration = await hoverAt(declarationMarker, token);
            assert.equal(declaration?.contents.value.split('\n')[0], token + ': ' + type);
            for (const marker of uses) {
                const result = await hoverAt(marker, token);
                assert.equal(result?.contents.value.split('\n')[0], token + ': ' + type);
                const definition = await connection.sendRequest('textDocument/definition', {
                    textDocument: { uri }, position: at(marker, token)
                });
                assert.deepEqual(definition, { uri, range: declaration.range });
                captures.push({ token, marker, result, definition });
            }
        }
        const induction = [];
        for (const [token, declarationMarker, useMarker, type] of [
            ['ascending', 'for ascending', 'yield ascending', 'int'],
            ['descending', 'for descending', 'yield descending', 'int'],
            ['item', 'for item in seq', 'ignore item', 'int<m>']
        ]) {
            const result = await hoverAt(useMarker, token);
            assert.equal(result?.contents.value.split('\n')[0], token + ': ' + type);
            const start = at(declarationMarker, token);
            const definition = await connection.sendRequest('textDocument/definition', {
                textDocument: { uri }, position: at(useMarker, token)
            });
            assert.deepEqual(definition, { uri, range: {
                start, end: { line: start.line, character: start.character + token.length }
            } });
            induction.push({ token, result, definition });
        }
        return { version, results, child, captures, induction };
    };
    const loopCaptureHovers = async () => {
        const lines = valid.split('\n');
        const hoverAt = async (marker, name, reference) => {
            const line = lines.findIndex(text => text.includes(marker));
            assert.ok(line >= 0, marker);
            const character = reference ? lines[line].lastIndexOf(name) : lines[line].indexOf(name);
            return connection.sendRequest('textDocument/hover', { textDocument: { uri }, position: { line, character } });
        };
        const result = await hover('loopCapture');
        const declared = await hoverAt('let visit', 'visit', false);
        const used = await hoverAt('visit 0', 'visit', true);
        const captured = await hoverAt('let visit', 'index', true);
        assert.equal(result?.contents.value.split('\n')[0], 'loopCapture: unit');
        assert.equal(declared?.contents.value.split('\n')[0], 'visit: int -> unit');
        assert.equal(used?.contents.value.split('\n')[0], 'visit: int -> unit');
        assert.equal(captured?.contents.value.split('\n')[0], 'index: int');
        const captureLine = lines.findIndex(text => text.includes('let visit'));
        const definition = await connection.sendRequest('textDocument/definition', {
            textDocument: { uri }, position: { line: captureLine, character: lines[captureLine].lastIndexOf('index') }
        });
        const line = lines.findIndex(text => text.includes('for index = 1 to 2'));
        const character = lines[line].indexOf('index');
        assert.deepEqual(definition, { uri, range: { start: { line, character }, end: { line, character: character + 'index'.length } } });
        return { version, result, declared, used, captured, definition };
    };
    const captureHovers = async () => {
        const lines = directCaptures.split('\n');
        const checks = [];
        for (const [name, type, declaration, reference] of [
            ['shift', 'int<m> -> int<m>', 'let shift', 'let shifted = shift'],
            ['plain', 'int<m> -> int<m>', 'let plain', 'let unchanged = plain'],
            ['make', 'unit -> int<m> -> int<m>', 'let make', 'let produced = make']
        ]) {
            for (const [site, marker] of [['declaration', declaration], ['reference', reference]]) {
                const line = lines.findIndex(text => text.includes(marker));
                assert.ok(line >= 0, marker);
                const character = site === 'reference' ? lines[line].lastIndexOf(name) : lines[line].indexOf(name);
                const result = await connection.sendRequest('textDocument/hover', {
                    textDocument: { uri }, position: { line, character }
                });
                assert.equal(result?.contents.value.split('\n')[0], name + ': ' + type,
                    name + ' ' + site + ': original source arity and dimensions');
                checks.push({ name, site, version, result });
            }
        }
        const line = lines.findIndex(text => text.includes('let produced'));
        const result = await connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: { line, character: lines[line].indexOf('produced') }
        });
        assert.equal(result?.contents.value.split('\n')[0], 'produced: int<m>');
        checks.push({ name: 'produced', site: 'result', version, result });
        const declarationLine = lines.findIndex(text => text.includes('let offset'));
        const declaration = await connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: { line: declarationLine, character: lines[declarationLine].indexOf('offset') }
        });
        assert.equal(declaration?.contents.value.split('\n')[0], 'offset: int<m>');
        assert.equal(declaration.range.start.line, declarationLine);
        const captureLine = lines.findIndex(text => text.includes('let shift'));
        const capturedPosition = { line: captureLine, character: lines[captureLine].lastIndexOf('offset') };
        const captured = await connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: capturedPosition
        });
        assert.equal(captured?.contents.value.split('\n')[0], 'offset: int<m>');
        const definition = await connection.sendRequest('textDocument/definition', {
            textDocument: { uri }, position: capturedPosition
        });
        assert.deepEqual(definition, { uri, range: declaration.range },
            'A captured reference resolves to the original source binding, not its generated formal.');
        checks.push({ name: 'offset', site: 'captured reference', version, result: captured, definition });
        return checks;
    };
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
        evidence.optionalFallbackHovers = [];
        for (const [name, type] of [
            ['optionalEager', 'int<m> option'], ['optionalDeferred', 'int<m> option'],
            ['optionalPartial', 'int<m> option'], ['optionalDelayedPartial', 'int<m> option'],
            ['optionalBare', 'int<m> option'], ['optionalDelayedBare', 'int<m> option'],
            ['optionalChoose', 'int<m> option -> int<m> option'],
            ['optionalDelayedChoose', 'int<m> option -> int<m> option']
        ]) {
            const result = await hover(name);
            assert.equal(result?.contents.value.split('\n')[0], name + ': ' + type,
                name + ': optional result and dimensions');
            evidence.optionalFallbackHovers.push({ name, version, result });
        }
        evidence.iterationHovers = [];
        for (const [name, type] of [
            ['iterationResult', 'unit'], ['iterationPartial', 'unit'],
            ['iterationBare', 'unit'], ['iterationBareSeconds', 'unit'],
            ['iterationAction', 'int<m> option -> unit']
        ]) {
            const result = await hover(name);
            assert.equal(result?.contents.value.split('\n')[0], name + ': ' + type);
            evidence.iterationHovers.push({ name, version, result });
        }
        evidence.foldHovers = [];
        for (const [name, type] of [
            ['folded', 'int<m>'], ['foldedBack', 'int<m>'],
            ['foldPartial', 'int<s> option -> int<m>'], ['foldBackPartial', 'int<m> -> int<m>'],
            ['foldBare', 'int<m>'], ['foldBackBare', 'int<m>']
        ]) {
            const result = await hover(name);
            assert.equal(result?.contents.value.split('\n')[0], name + ': ' + type);
            evidence.foldHovers.push({ name, version, result });
        }
        evidence.resultHovers = [];
        for (const [name, type] of [
            ['resultMapped', 'Result<int<kg>, int<s>>'],
            ['resultErrorMapped', 'Result<int<m>, int<kg>>'],
            ['resultBound', 'Result<int<kg>, int<s>>'],
            ['resultMapPartial', 'Result<int<m>, int<s>> -> Result<int<kg>, int<s>>'],
            ['resultDefaulted', 'int<m>'], ['resultRecovered', 'int<m>'], ['resultIterated', 'unit'],
            ['resultRecover', 'Result<int<m>, int<s>> -> int<m>'],
            ['resultIsOk', 'bool'], ['resultIsError', 'bool'],
            ['resultIsOkPredicate', 'Result<int<m>, int<s>> -> bool'],
            ['resultIsErrorPredicate', 'Result<int<s>, int<m>> -> bool']
        ]) {
            const result = await hover(name);
            assert.equal(result?.contents.value.split('\n')[0], name + ': ' + type);
            evidence.resultHovers.push({ name, version, result });
        }
        const rangeHover = await hover('rangeLoop');
        assert.equal(rangeHover?.contents.value.split('\n')[0], 'rangeLoop: unit');
        const validLines = valid.split('\n');
        const loopLine = validLines.findIndex(line => line.includes('for index in (-2 .. 2)'));
        assert.ok(loopLine >= 0);
        const inductionHover = await connection.sendRequest('textDocument/hover', {
            textDocument: { uri }, position: { line: loopLine, character: validLines[loopLine].lastIndexOf('index') }
        });
        assert.equal(inductionHover?.contents.value.split('\n')[0], 'index: int');
        evidence.rangeLoopHovers = { version, result: rangeHover, induction: inductionHover };
        evidence.loopCapture = await loopCaptureHovers();
        evidence.loopCaptureRepairs = [];
        evidence.nativeSequence = await hover('nativeSequence');
        assert.equal(evidence.nativeSequence?.contents.value.split('\n')[0], 'nativeSequence: seq<int<m>>');
        evidence.ceRepairs = [];
        evidence.nestedSequence = await nestedSequenceHovers();
        evidence.capturedSequence = await capturedSequenceHovers();
        evidence.sequenceRepairs = [];
        evidence.sequenceProducers = await sequenceProducerHovers();
        evidence.sequenceProducerRepairs = [];
        evidence.sequenceOwnership = await sequenceOwnershipHovers();
        evidence.sequenceOwnershipRepairs = [];
        evidence.delegation = await delegationHovers();
        evidence.sequenceEvaluation = await sequenceEvaluationHovers();
        evidence.sequenceContinuation = await sequenceContinuationHovers();
        evidence.sequenceContinuationRepairs = [];
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
            if (name === 'intrinsic Math.sin dimension') {
                evidence.lexicalMathRepairs = [];
                for (const [lexicalName, body] of lexicalMath) {
                    const lexicalSource = prelude + body + entry;
                    noErrors(await change(lexicalSource));
                    const result = await connection.sendRequest('textDocument/hover', {
                        textDocument: { uri },
                        position: position(lexicalSource.slice(0, lexicalSource.indexOf('let selected =') + 5))
                    });
                    assert.equal(result?.contents.value.split('\n')[0], 'selected: int<m>', lexicalName);
                    evidence.lexicalMathRepairs.push({ name: lexicalName, source: lexicalSource, version, result });
                    console.log('PASS: ' + lexicalName + ' measured hover and unsaved repair');
                }
            }
            noErrors(await change(valid));
            assert.match((await hover('selected'))?.contents.value ?? '', /selected: int<m>/,
                name + ': unsaved correction restores the measured hover');
            if (name.startsWith('CE ')) {
                const [binding, type] = name === 'CE custom builder' ? ['resultIterated', 'unit'] : ['nativeSequence', 'seq<int<m>>'];
                const result = await hover(binding);
                assert.equal(result?.contents.value.split('\n')[0], binding + ': ' + type);
                evidence.ceRepairs.push({ name, version, result });
                if (name === 'CE seq lambda yield' || name === 'CE seq lazy yield')
                    evidence.sequenceOwnershipRepairs.push(await sequenceOwnershipHovers());
            }
            if (name.startsWith('Sequence ')) evidence.sequenceRepairs.push(await nestedSequenceHovers());
            if (name === 'Sequence consumption scalar input')
                evidence.sequenceContinuationRepairs.push(await sequenceContinuationHovers());
            if (name.startsWith('Seq producer ')) evidence.sequenceProducerRepairs.push(await sequenceProducerHovers());
            if (name.startsWith('Result.default') || name.startsWith('Result.iter') || name.startsWith('Result.is')) {
                const operation = name.split(' ')[0];
                const [binding, type] = {
                    'Result.defaultValue': ['resultDefaulted', 'int<m>'],
                    'Result.defaultWith': ['resultRecover', 'Result<int<m>, int<s>> -> int<m>'],
                    'Result.iter': ['resultIterated', 'unit'],
                    'Result.isOk': ['resultIsOkPredicate', 'Result<int<m>, int<s>> -> bool'],
                    'Result.isError': ['resultIsErrorPredicate', 'Result<int<s>, int<m>> -> bool']
                }[operation];
                assert.equal((await hover(binding))?.contents.value.split('\n')[0], binding + ': ' + type,
                    operation + ': unsaved repair restores the Result projection');
                if (operation.startsWith('Result.is')) {
                    const resultBinding = operation === 'Result.isOk' ? 'resultIsOk' : 'resultIsError';
                    assert.equal((await hover(resultBinding))?.contents.value.split('\n')[0], resultBinding + ': bool');
                }
            }
            if (name.startsWith('immutable loop')) {
                assert.match(errors[0].message, /not found or not mutable/);
                evidence.loopCaptureRepairs.push(await loopCaptureHovers());
            }
            console.log('PASS: ' + name + ' and unsaved correction');
        }
        noErrors(await change(directCaptures));
        evidence.directCaptures = { source: directCaptures, hovers: await captureHovers() };
        const marked = directCaptures.replace('shift 3<m>', '«shift 3<s>»');
        const prefix = marked.slice(0, marked.indexOf('«'));
        const span = marked.slice(marked.indexOf('«') + 1, marked.indexOf('»'));
        const source = marked.replace('«', '').replace('»', '');
        const publication = await change(source);
        const errors = publication.diagnostics.filter(row => row.severity === 1);
        assert.equal(errors.length, 1, 'direct capture explicit argument: one effective compiler error');
        assert.equal(errors[0].source, 'CCS');
        assert.equal(errors[0].code, 'CCS8040');
        assert.deepEqual(errors[0].range, { start: position(prefix), end: position(prefix + span) });
        evidence.cases.push({ name: 'direct capture explicit argument dimension', version, source, diagnostic: errors[0] });
        noErrors(await change(directCaptures));
        evidence.directCaptures.repairedHovers = await captureHovers();
        console.log('PASS: direct-capture source signatures, explicit argument rejection and unsaved correction');
        noErrors(await change(valid));
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
        console.log('PASS: ' + evidence.cases.length + ' compiler-surface diagnostic edits and corrections; ' + path.join(root, 'result.json'));
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
