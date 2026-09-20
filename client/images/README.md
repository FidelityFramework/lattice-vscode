# Clef icon

`clef.svg` reuses the bass-clef path and viewBox from [clef-lang-site's logo.svg](https://github.com/FidelityFramework/clef-lang-site/blob/main/hugo/static/images/logo.svg). The geometry is unchanged; editor metadata was removed and the white fill changed to Braidpoint orange `#ec6911`, from `path55` in [Braidpoint_Logo.svg](https://github.com/FidelityFramework/braidpoint-site/blob/main/hugo/static/images/Braidpoint_Logo.svg).

Source content: Copyright 2025–2026 SpeakEZ Technologies, LLC, under the site's [CC BY 4.0 content license](https://github.com/FidelityFramework/clef-lang-site/blob/main/LICENSE-CONTENT). This attribution and the source license apply to these assets separately from the client's code license.

`clef.png` is a 256 × 256 transparent extension tile rendered from the SVG. To reproduce it from this directory with librsvg:

```sh
rsvg-convert -w 256 -h 256 -o clef.png clef.svg
```

`fidproj.svg` uses the same geometry with Braidpoint teal `#468f99` (the palette's `color2` in the same source SVG). It distinguishes project files from orange Clef source files without changing their TOML language mode.

The optional **Lattice (Seti + Clef)** file-icon theme is prepared from a locally installed VS Code Seti theme, preserving its associations and overlaying only `.clef` and `.fidproj`. Run `node scripts/prepare-icons.cjs` from the client directory, or supply `--code /path/to/code` or `--theme /path/to/theme-seti`. The current demo has been checked with Linux `/usr/share/code`; other layouts can use the explicit theme path. Generated `icons/` assets are ignored, retain Seti's third-party notices and this attribution, and include SHA-256 provenance for each copied source. Theme preparation does not select a theme or alter editor settings.
