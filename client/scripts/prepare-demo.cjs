'use strict';

// A copier for one known fixture, not a TOML project loader.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function executable(command) {
    const candidates = command.includes('/') || command.includes('\\') ? [path.resolve(command)] :
        (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, command));
    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            // Keep argv[0] for executable shims such as mise's dotnet symlink.
            if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
        } catch { /* Continue PATH lookup. */ }
    }
    throw new Error('Executable not found: ' + command);
}

function prepareDemo(options = {}) {
    const client = path.resolve(__dirname, '..');
    const peers = path.resolve(client, '../..');
    const composer = path.resolve(options.composer ?? path.join(peers, 'Composer'));
    const source = path.join(composer, 'samples/lattice/HelloDimensionsProof');
    const workspace = path.resolve(options.output ?? path.join(client, '.demo'));
    const platform = path.resolve(options.platform ??
        path.join(peers, 'Fidelity.Platform/Profiles/Linux_x86_64_Default/Fidelity.Platform.fidproj'));
    const server = path.resolve(options.server ??
        path.join(composer, 'src/Lattice.Server/bin/Debug/net10.0/Lattice.Server.dll'));
    const dotnet = executable(options.dotnet ?? 'dotnet');
    const solver = executable(options.solver ?? 'cvc5');
    for (const file of [platform, server]) {
        if (!fs.statSync(file).isFile()) throw new Error('Required input is not a file: ' + file);
    }

    const projectName = 'HelloDimensionsProof.fidproj';
    const files = [projectName, 'Units.clef', 'Main.clef'];
    const originals = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(source, file))]));
    const marker = '"../../../../Fidelity.Platform/Profiles/Linux_x86_64_Default/Fidelity.Platform.fidproj"';
    const manifest = originals[projectName].toString('utf8');
    if (manifest.split(marker).length !== 2) {
        throw new Error('The known demo platform dependency changed; review this fixture copier.');
    }
    const rebased = manifest.replace(marker, JSON.stringify(platform.replaceAll('\\', '/')));
    const sourceHashes = Object.fromEntries(files.map(file => [file, sha256(originals[file])]));
    const fixtureIdentity = sha256(JSON.stringify({ source, platform, sourceHashes }));
    const provenancePath = path.join(workspace, '.lattice-demo.json');
    const existing = fs.existsSync(workspace);
    if (existing) {
        if (!fs.existsSync(provenancePath)) {
            throw new Error('Refusing to overwrite an existing non-demo directory: ' + workspace);
        }
        const previous = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
        if (previous.fixtureIdentity !== fixtureIdentity ||
            fs.readFileSync(path.join(workspace, projectName), 'utf8') !== rebased) {
            throw new Error('Demo inputs or project changed; choose a new --output directory to preserve edits.');
        }
        for (const file of ['Main.clef', 'Units.clef']) fs.accessSync(path.join(workspace, file));
    } else {
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(path.join(workspace, projectName), rebased);
        for (const file of ['Units.clef', 'Main.clef']) fs.writeFileSync(path.join(workspace, file), originals[file]);
    }
    const project = path.join(workspace, projectName);
    const settingsPath = path.join(workspace, '.vscode/settings.json');
    const settings = {
        ...(fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {}),
        'lattice.server.command': dotnet,
        'lattice.server.args': [server, '--project', project, '--solver', solver],
        'workbench.startupEditor': 'none'
    };
    if (!Object.hasOwn(settings, 'workbench.iconTheme')) settings['workbench.iconTheme'] = 'lattice-clef';
    if (!Object.hasOwn(settings, 'workbench.colorTheme')) settings['workbench.colorTheme'] = 'Dark Modern';
    if (!Object.hasOwn(settings, 'window.title')) settings['window.title'] = 'Lattice · HelloDimensionsProof${separator}${appName}';
    // Explicit workspace associations override older user-level F# mappings.
    // Icons alone do not select the language or activate its language server.
    settings['files.associations'] = {
        ...settings['files.associations'],
        '*.clef': 'clef',
        '*.fidproj': 'toml'
    };
    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    // Language association supplies highlighting; Taplo also needs to include
    // the project extension for formatting and syntax diagnostics. Preserve an
    // existing native config rather than replace its project-specific choices.
    let tomlConfiguration = ['.taplo.toml', 'taplo.toml'].map(file => path.join(workspace, file))
        .find(file => fs.existsSync(file));
    if (!tomlConfiguration) {
        tomlConfiguration = path.join(workspace, '.taplo.toml');
        fs.writeFileSync(tomlConfiguration, 'include = ["**/*.toml", "**/*.fidproj"]\n');
    }
    const result = {
        version: 1, workspace, project, main: path.join(workspace, 'Main.clef'),
        source, platform, server, dotnet, solver, fixtureIdentity, sourceHashes, tomlConfiguration,
        serverSha256: sha256(fs.readFileSync(server)),
        preservedSourceEdits: ['Main.clef', 'Units.clef'].some(file =>
            sha256(fs.readFileSync(path.join(workspace, file))) !== sourceHashes[file])
    };
    fs.writeFileSync(provenancePath, JSON.stringify(result, null, 2) + '\n');
    return result;
}

if (require.main === module) {
    const options = {};
    const allowed = new Set(['output', 'composer', 'platform', 'server', 'dotnet', 'solver']);
    for (let i = 2; i < process.argv.length; i += 2) {
        const name = process.argv[i].replace(/^--/, '');
        if (!allowed.has(name) || process.argv[i + 1] === undefined) {
            throw new Error('Expected --output/--composer/--platform/--server/--dotnet/--solver followed by a path.');
        }
        options[name] = process.argv[i + 1];
    }
    console.log(JSON.stringify(prepareDemo(options), null, 2));
}

module.exports = { prepareDemo };
