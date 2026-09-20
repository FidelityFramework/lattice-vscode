# lattice-vscode

The VS Code client for Lattice, forked from
[Ionide for F#](https://github.com/ionide/ionide-vscode-fsharp) at 7.30.0.
The active Clef extension lives in `client/`; the inherited extension remains
separate reference material.

The shared [Lattice integration plan](https://github.com/FidelityFramework/Composer/blob/main/docs/Lattice_Integration.md)
defines the integration boundaries and remaining work. CCS owns Clef
semantics; the client presents compiler results and routes editor actions.

## Current implementation

The [local development client](client/README.md) now registers `.clef`, loads the
peer `clef-grammar`, and connects an explicitly configured stdio server using the
standard VSCode language-client library. Open `client/` in VSCode to use its F5
launch configuration. No publication or Marketplace credentials are needed.
The **Lattice: HelloDimensionsProof** launch connects the local server in Composer
to measured-type hover, diagnostics, resolved definitions and expandable source
proofs checked by cvc5. The client does not supply compiler semantics or a bundled server.

The inherited `src/` and `release/` implementation still starts upstream FsAutoComplete through `dotnet` and uses
its F# workspace and feature protocols. The build bundles FSAC from NuGet.
The manifest registers `.fs`, `.fsi`, `.fsx` and `.fsnx` as `fsharp`; `.fidproj`
activates the extension and has a TOML association, but the project explorer does
not yet consume CCS's `.fidproj` model. The working Clef development path is in
`client/`, including separate source/project icons and a TOML companion for manifests.

The reusable foundation is concrete: the
[`LanguageClient` registration](src/Core/LanguageService.fs), process discovery,
server start/stop and standard LSP feature handling. The current
`FSharp.fsac.netCoreDllPath` setting accepts an explicit server DLL for development,
but the launch path also supplies FSAC arguments and runs FSAC-specific workspace
requests. Pointing it at another DLL alone does not establish Clef support.

The active Lattice server is **.NET-hosted**, consuming CCS from the compiler
workspace. That is the server's implementation environment; it does not make a
native or freestanding Clef program a .NET application. F# Interactive, MSBuild,
CLR debugging and test integration are inherited client features, not requirements
of the Clef editing path. Their registration must follow the supported server and
project capabilities.

## Compiler-backed validation

The current client/server gates cover one selected Clef project:

1. Clef registration, explicit server launch and standard LSP synchronization.
   CCS loads the `.fidproj`, source order, platform and dependency inputs.
2. Compiler-provided dimensional hovers, resolved definitions and exact diagnostic
   codes/spans, with unsaved errors and repairs at the checked document version.
3. Restart/shutdown and stale-result rejection, with the actual server assembly
   identities retained in the protocol evidence.
4. Selected-platform storage designations and the read-only
   `clef/programInitialization` query: ordered initializer IDs/source spans,
   storage intent, authority and pending native facts supplied by the PSG.

The [C-07 implementation record](https://github.com/FidelityFramework/Composer/blob/main/docs/Language_Coverage_Waypoints.md#c-07-sequence-operations--implementation-waypoint-acceptance-open-2026-09-20)
pins these gates to their compiler and tooling revisions. Its consolidated CCS
suite passed 987 tests; selected-platform and source-only startup LSP gates passed
on `da1f5790`. This does not close C-07's remaining original-sample and staged
sequence-operation acceptance gates. Run the focused checks documented in
[client/README.md](client/README.md); no client intrinsic catalogue is involved.

The negotiated proof view now uses that route. The client must preserve compiler diagnostic codes, premises and freshness;
it must not infer a range, assign a proof verdict or change semantic policy itself.
The local server dispatches compiler-generated source queries and distinguishes
successful, inconclusive and failed results. A listed obligation is not a successful proof;
source verification does not establish preservation through lowering.

The real F5 and proof host gates exercise the `client/` workspace. The root
`.vscode/` configurations provide equivalent paths into that client and have
static configuration checks; a separate root-workspace F5 run is not recorded.
There is no published server package or validated Marketplace release. Completion,
references, semantic tokens, multi-project service and native build/debug commands
remain outside the advertised server boundary.

## Inherited dependency alignment

The new client has its own small, pinned npm dependency set and does not load the
inherited Fable extension. Reusing or extending that implementation still requires
aligning its helper source dependency as one reviewed change:
[`paket.dependencies`](paket.dependencies) names `FidelityFramework/lattice-vscode-helpers`,
while [`paket.lock`](paket.lock) and the source includes in
[`src/Ionide.FSharp.fsproj`](src/Ionide.FSharp.fsproj) still select the Ionide helper
source. Resolve and pin the intended helper revision, update its source references,
and validate a fresh acquisition before treating a local build as reproducible.
The [helpers repository](https://github.com/FidelityFramework/lattice-vscode-helpers)
remains process and protocol plumbing.

The inherited build entry point is [`build.sh`](build.sh), using
[`global.json`](global.json), the [tool manifest](.config/dotnet-tools.json) and
[`package.json`](package.json). Any reuse of that extension needs its own dependency
and protocol validation; the active client's gates do not validate the inherited
release pipeline.

## Heritage

Ionide is the work of Krzysztof Cieślak and the Ionide community. Its F# tooling is
the foundation of this client. Upstream license and attribution are preserved in
[LICENSE.md](LICENSE.md).
