# Lattice for Visual Studio Code

The retained release entry point from the
[Ionide for F#](https://github.com/ionide/ionide-vscode-fsharp) fork.

## Status

This is the inherited release entry point. The [local Clef development client](../client/README.md)
has its own manifest and F5 setup; it does not load this extension or require Marketplace publication.

This extension retains the inherited F# language-service path and bundles
upstream FsAutoComplete. It registers `.fs`, `.fsi`, `.fsx` and `.fsnx` as F#.
The `.fidproj` activation and TOML association are present, but native Clef project
loading, dimensional/range views and proof tooling are not implemented by those
associations.

The separate development client connects to the .NET-hosted Lattice server that consumes CCS.
The server's .NET host is separate from the native or freestanding target of a
Clef program. The existing `LanguageClient` and process plumbing provide a starting
point; the inherited FSAC workspace requests and launch arguments need to be aligned
with the selected server if reused. The `clef` language ID and `lattice.*`
settings/command namespace are implemented in the separate development client;
they are not setup instructions for this inherited release.

## Active client validation

The active client has passed real-server dimensional hover, diagnostic, definition
and unsaved-repair gates. CCS owns ordered project inputs and source semantics;
the server associates responses with the checked version. Its read-only startup
query projects PSG initializer order, source identities and pending native facts.
The [C-07 evidence record](https://github.com/FidelityFramework/Composer/blob/main/docs/Language_Coverage_Waypoints.md)
records the exact source, native and editor artifacts separately, including the
remaining language acceptance gaps. None of these results claims that this
inherited release extension implements the active Clef path.

Proof views follow the compiler's query and result contracts. An obligation's
presence does not mean it has been discharged. The editor presents evidence and
premises supplied by the shared service; it does not decide proof outcomes.

The [Lattice integration plan](https://github.com/FidelityFramework/Composer/blob/main/docs/Lattice_Integration.md)
tracks this work. The [repository README](https://github.com/FidelityFramework/lattice-vscode/blob/fidelity/README.md)
links the current launch implementation, build manifests and helper dependency
alignment needed if this inherited extension is reused. There is no published
Lattice server package or validated Marketplace release. The recorded real F5
gate uses the `client/` workspace; root-workspace launch configurations have only
static configuration validation. Mixed-extension coexistence is limited to the
tested client cases.

## Heritage and license

Lattice builds on the work of Krzysztof Cieślak and the Ionide community. Their
contribution and upstream attribution remain part of this fork.

MIT License — see [LICENSE.md](LICENSE.md).
