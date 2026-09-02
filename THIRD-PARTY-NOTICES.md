# Third-Party Notices

## JetBrainsMono Nerd Font Mono Regular

- Version: Nerd Fonts v3.5.1, based on JetBrains Mono
- Source: https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1
- Release asset: `JetBrainsMono.tar.xz`
- Release archive SHA-256: `04d5e8f903693f9dd13e16f867e994834e681eb3c72c0d337a770dcda09010cf`
- Source TTF: `JetBrainsMonoNerdFontMono-Regular.ttf`
- Source TTF SHA-256: `f2a5ea6cfab397445ffab00c0370927b66d61e560a05db5db271b42006381c1a`
- Bundled file: `apps/web/src/assets/fonts/WollipogJetBrainsMonoNerd-Regular.woff2`
- Bundled file SHA-256: `97fdb22918dfc1082fbaa4b90db77320baa806d0017834af31650a678ee5c80d`
- Modifications: subset and WOFF2 conversion with FontTools 4.64.0. The retained ranges are Basic
  Latin through Latin Extended-B (`U+0020-024F`), Greek and Cyrillic (`U+0370-052F`), common
  punctuation/arrows/technical/box-drawing/geometric/dingbat/braille ranges (`U+2000-206F`,
  `U+2190-21FF`, `U+2300-23FF`, `U+2500-259F`, `U+25A0-27BF`, `U+2800-28FF`, `U+2B00-2BFF`),
  Powerline (`U+E000-E0D7`), Seti UI and Devicons (`U+E5FA-E7C5`), Font Awesome through Octicons
  (`U+F000-F532`), and the representative Material Design Git glyph (`U+F02A2`). Layout features,
  names, hinting, `.notdef`, and recommended glyphs were retained.
- License: SIL Open Font License 1.1; the complete license is distributed beside the font as
  `JetBrainsMonoNerdFontMono-LICENSE.txt`
- Copyright: Copyright 2020 The JetBrains Mono Project Authors

Measured bundle cost for the unchanged font file:

| Representation | Bytes |
| --- | ---: |
| Bundled WOFF2 | 298,204 |
| gzip level 9 | 298,312 |
| Brotli quality 11 | 298,209 |

Wollipog bundles this single subset locally for terminal glyph coverage. It is referenced through
the web stylesheet, so both the production web build and the packaged desktop webview include the
same hashed offline asset without contacting an external font service.
