# Third-Party Notices

## JetBrainsMono Nerd Font Mono Regular

- Version: Nerd Fonts v3.5.1, based on JetBrains Mono
- Source: https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1
- Release asset: `JetBrainsMono.tar.xz`
- Release archive SHA-256: `04d5e8f903693f9dd13e16f867e994834e681eb3c72c0d337a770dcda09010cf`
- Source TTF: `JetBrainsMonoNerdFontMono-Regular.ttf`
- Source TTF SHA-256: `f2a5ea6cfab397445ffab00c0370927b66d61e560a05db5db271b42006381c1a`
- Bundled file: `apps/web/src/assets/fonts/WollipogJetBrainsMonoNerd-Regular.woff2`
- Bundled file SHA-256: `76468bdf3e032ac0a890e83a15126bf71362c774a85851653cf000845dd7e91e`
- Modifications: subset and WOFF2 conversion with FontTools 4.64.0. The retained ranges are Basic
  Latin through Latin Extended-B (`U+0020-024F`), Greek and Cyrillic (`U+0370-052F`), common
  punctuation/arrows/technical/box-drawing/geometric/dingbat/braille ranges (`U+2000-206F`,
  `U+2190-21FF`, `U+2300-23FF`, `U+2500-259F`, `U+25A0-27BF`, `U+2800-28FF`, `U+2B00-2BFF`),
  Powerline (`U+E0A0-E0D7`), Seti UI (`U+E5FA-E6BB`), Devicons (`U+E700-E958`), Font Awesome
  (`U+F000-F2FF`), Octicons (`U+F400-F532`), and the representative Material Design Git glyph
  (`U+F02A2`). Unlicensed Font Logos and unrelated private-use ranges are intentionally excluded.
  Layout features, names, hinting, `.notdef`, and recommended glyphs were retained.
- License: SIL Open Font License 1.1; the complete license is distributed beside the font as
  `JetBrainsMonoNerdFontMono-LICENSE.txt`
- Copyright: Copyright 2020 The JetBrains Mono Project Authors
- Glyph-source notices and license terms: `apps/web/src/assets/fonts/NerdFontsGlyphs-LICENSES.txt`

Measured bundle cost for the bundled subset:

| Representation | Bytes |
| --- | ---: |
| Bundled WOFF2 | 383,272 |
| gzip level 9 | 382,380 |
| Brotli quality 11 | 383,277 |

Wollipog bundles this single subset locally for terminal glyph coverage. It is referenced through
the web stylesheet, so both the production web build and the packaged desktop webview include the
same hashed offline asset without contacting an external font service.
