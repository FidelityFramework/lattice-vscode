# Local Lattice client

This development extension connects Clef files to the .NET-hosted [Lattice server](https://github.com/FidelityFramework/Composer/tree/main/src/Lattice.Server), using CCS for dimensions, diagnostics and resolved references. The **Clef Proofs** panel expands compiler-authored obligations and their current cvc5 results. `.clef` is a separate language from `.fs`.

The small JavaScript entry point handles VSCode lifecycle, transport and presentation. It does not load the inherited F#/Fable implementation in `../src` or `../release`. Inference, project ordering and obligation construction remain in CCS. The server and cvc5 are local tools, not bundled extension dependencies.

## Open the working demo

Keep `lattice-vscode`, `clef-grammar`, `Composer`, `clef`, `Fidelity.Platform`, `Fidelity.Data` and `BAREWire` as peer checkouts. Use VSCode 1.90+, Node.js 22+, .NET 10 and cvc5. The sample currently selects Linux x86-64 platform declarations. This directory's `.nvmrc` and `.tool-versions` select Node 22 without changing the inherited build's settings.

1. Open **this `client` directory** in VSCode and run `npm ci` in its terminal.
2. Select **Lattice: HelloDimensionsProof** in Run and Debug, then press **F5**.
3. Hover over `velocity` in `Main.clef`: CCS reports `float<m / s>`. Go to definition on `speed` to reach `Units.clef`.
4. Replace `3.0<s>` with `3.0<m>`. CCS reports **CCS8040** at the `speed distance elapsed` call. Restore seconds and the error clears without saving.
5. Expand **Clef Proofs** in Explorer. Each obligation exposes its statement, source, graph premises, reasoning fragment and dispatch status. Expand **Solver query** for its SHA-256 and exact SMT-LIB.

The **Clef Proofs** sidebar groups evidence by file, then by source line, then by obligation. Each source drawer shows the line's code, obligation count and status summary. Clicking a source link selects that drawer, keeping all its obligations together; expand an individual obligation for its details. Related source sites from other files and obligations without a source location have separate groups.

Click the **beaker** in the editor title, proof-panel toolbar or status bar to show or hide the compact source links. The same action is available as **Lattice: Toggle Source Proof Links** in the Command Palette and uses the boolean `lattice.proofs.showAnnotations` setting. Hiding links leaves proof checking, updates, and the sidebar's contents and expansion state intact.

The proof-panel toolbar has separate **Expand All Proofs** and **Collapse All Proofs** buttons, also available in the Command Palette. Expand All opens file groups, source drawers, obligations, premises, references and solver queries; Collapse All closes the drawers while retaining the file headers and evidence. Neither action changes source-link visibility or reruns proofs. The section's own caret folds the panel in the usual VSCode way; reopening it restores access to the same tree.

The F5 task builds `Composer/src/Lattice.Server` from the Composer directory, prepares grammar/icons, installs the pinned TOML companion into an isolated extension directory, and copies the sample into ignored `.demo/`. It preserves later edits to the copied sources. If the upstream fixture or copied manifest changes, preparation requires a fresh output directory instead of replacing your edits. The original sample stays intact.

No Marketplace account or publishing token is needed for an [Extension Development Host](https://code.visualstudio.com/api/get-started/your-first-extension). The first TOML preparation downloads the published extension; subsequent runs reuse its pinned installation in `.demo-extensions/`. F5 loads Lattice and that companion through two explicit development-extension paths. This avoids changing your installed extensions or relying on a different extension directory within an already running VSCode instance.

The copied workspace explicitly associates `*.clef` with Clef and `*.fidproj` with TOML, overriding older user-level F# associations for this demo. Existing source edits, unrelated associations and theme choices are retained. After changing the launch configuration, stop the development session and press F5 again so the new extension paths take effect.

The same **Lattice: HelloDimensionsProof** configuration is available from the repository root; install dependencies in `client/` first. The tasks assume peer checkouts. For other locations, `node scripts/prepare-demo.cjs` accepts `--output`, `--composer`, `--platform`, `--server`, `--dotnet` and `--solver`.

The demo uses Composer's existing CCS reference to the peer `clef` checkout. It does not merge or supersede the separate dimensional rescue worktree. The [integration design](https://github.com/FidelityFramework/Composer/blob/main/docs/Lattice_Integration.md) records that remaining reconciliation.

## Source and project presentation

Clef source uses the bass-clef icon in Braidpoint orange, `#EC6911`. Project files use the same geometry in Braidpoint teal, `#468F99`. The optional **Lattice (Seti + Clef)** file-icon theme preserves the installed Seti icons and overrides only `.clef` and `.fidproj`. The demo selects it at workspace scope. Other workspaces and user themes remain your choice: the selected [file-icon theme](https://code.visualstudio.com/api/extension-guides/file-icon-theme) controls these icons.

`.fidproj` stays in **TOML** mode. [Even Better TOML](https://github.com/tamasfe/taplo/tree/master/editors/vscode) supplies grammar, parser diagnostics, formatting and TOML navigation. Preparation adds a Taplo include for `**/*.fidproj` when no Taplo configuration exists; keep that include in an existing configuration. Project-specific schema completion needs an actual compiler/schema contract; generic TOML support does not validate CCS source ordering, dependency semantics or platform facts. Save manifest edits to trigger CCS project reloading; this server does not interpret unsaved manifest edits yet.

The demo defaults to **Dark Modern**, whose TOML key, string and other token colors are readily distinguishable. It retains an existing workspace color-theme choice. This is separate from the teal project icon and does not change your normal VSCode theme.

Other ordinary TOML files, including Composer's `Manifest.toml` and `expect.toml`, use the same syntax tooling. `.fidproj` already carries source order and local dependency declarations. ClefPak's proposed `cpk.lock` needs an exact filename association when its contract lands; a blanket `*.lock` association would claim unrelated formats. The planned `.fidpkg` is a source archive, not a TOML document. Each tool remains responsible for the meaning of its files.

`prepare:grammar` copies the peer `clef-grammar` into ignored packaging output, reports its hash and retains licenses. A custom path can be passed to `node scripts/prepare-grammar.cjs`. `prepare:icons` similarly retains the Seti font, notices and provenance with its generated overlay; use `--theme /path/to/theme-seti` for a nonstandard install. See [icon attribution](images/README.md).

## Connect another local project

**Run Lattice locally** opens the development client without preparing the sample. Configure your workspace:

```json
{
  "files.associations": { "*.clef": "clef", "*.fidproj": "toml" },
  "lattice.server.command": "dotnet",
  "lattice.server.args": [
    "/absolute/path/to/Composer/src/Lattice.Server/bin/Debug/net10.0/Lattice.Server.dll",
    "--project", "/absolute/path/to/Application.fidproj",
    "--solver", "/absolute/path/to/cvc5"
  ]
}
```

Arguments pass directly without shell expansion. An empty command disables startup. Changing these settings restarts the connection; **Lattice: Restart Server** does so explicitly. Superseded startup is cancelled; initialization has a 30-second timeout.

Current scope is one trusted local workspace with file-backed `.clef` documents. The server watches the check's source and manifest inputs, including external platform/library files. Edits invalidate proof evidence. `.clefx`, untitled documents, multiple projects, completion and native build/debug commands need further integration.

With the validated compiler integration, commenting out `open HelloDimensionsProof.Units` reports CCS8009 at `speed` and removes its resolved hover/definition. Restoring the import restores both. Removing and restoring the declaration itself is also covered. These results come from CCS module visibility and graph references.

**Proved · source** means cvc5 decided the compiler's negated obligation under its encoded premises. The sample's string and buffer obligations do not prove the measured calculation or preservation through native/JavaScript lowering. Syntax failures currently appear in Lattice output and as a failed-check message in the panel; precise parser diagnostic ranges remain work in CCS.

## Regression checks

From `client/` after preparation:

```sh
npm test
npm run test:options
npm run test:host
npm run test:f5-host
npm run test:ccs-host
npm run test:toml-host
```

The Node tests cover registration, lifecycle, cancellation and proof rendering, including invalid/stale responses. `test:host` uses a protocol fixture in real VSCode to check tokenization, transport, document lifecycle and unresponsive-server cancellation. It establishes no CCS semantics.

`test:options` uses the already built Lattice server over stdio to check measured
`Option.defaultValue` and `Option.defaultWith` results and stored-partial hover.
`Option.orElse` and `Option.orElseWith` cover exact dimensional optional results
through direct, partial and bare-alias applications. Invalid option/thunk payloads,
thunk domains and partial applications retain their exact compiler diagnostics.
The retained script name also covers direct immutable captures: declaration and
reference hovers preserve the exact source arity, dimensions and returned-function
result, with a captureless control. A wrong explicit argument requires CCS8040 at
the original call span; unsaved repair restores all seven callable/result projection
checks and resolves the captured variable back to its original declaration.
Unsaved negative cases must preserve CCS's effective error severity, exact source
span and existing codes (`CCS8003`, `CCS8004`, `CCS8040`, `CCS8041`, `CCS8048`);
corrections must clear the error at the new document version. It records all server
assembly hashes and diagnostic publications in a temporary evidence directory.
This gate does not build the compiler, need a platform dependency, or dispatch a
solver. Use `LATTICE_SERVER_DLL`, `LATTICE_COMPOSER_ROOT` or `LATTICE_DOTNET` to select
the coordinated build. It covers the real compiler/LSP path; `test:ccs-host`
separately covers rendered editor behavior. Completion remains pending until CCS
exposes its scope query; the client has no independent Option member catalogue.

`test:f5-host` launches the checked-in debug configuration from an already running VSCode parent with a legacy `*.clef` → F# association and no normally installed TOML extension. The child must load both development extensions, tokenize the project as TOML, return CCS dimensional hover, and publish and clear CCS8040 and CCS8009 after unsaved edits. It also clicks the rendered source-link toggle from the status bar, project editor and proof toolbar, including with the status bar hidden. The sidebar's separate Expand All and Collapse All controls must work while links remain hidden. The renderer probe uses a loopback debugging endpoint in the temporary test profile. This covers the F5 route separately from standalone host launches.

`test:ccs-host` uses real CCS and cvc5: dimensional hover, cross-file/local definitions, CCS8040 appearing and clearing after unsaved edits, actual proof-tree expansion, query/hash agreement, parser-failure recovery, and updated integer/real literal evidence. Obligation counts and the server artifact hash are recorded per run instead of assuming a fixed graph size. The 2026-09-19 run passed on VSCode 1.138.0 and cvc5 1.3.0.

`test:toml-host` checks rich TOML token categories, parsing and formatting through the installed companion. Each host test uses a temporary profile and prints its retained evidence path. Linux runs default to headless Ozone; use `LATTICE_TEST_OZONE=wayland` or `x11` for a visible run on those systems. Other platforms use a visible host by default. Pass another Code executable after `--`. Syntax assertions use a VSCode internal test command and fail explicitly if unavailable.

The [CCS.Editor tests](https://github.com/FidelityFramework/Composer/tree/main/tests/CCS.Editor.Tests) separately exercise immutable snapshots, shadowing, UTF-16/CRLF positions, external input inventories and real solver verdict boundaries. Neovim has its own real-editor protocol-fixture gate; its CCS semantic gate and plain Vim support remain work.
