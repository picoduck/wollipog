# Vite 8 Compatibility Epoch

Validated on 2026-08-29 against `main` commit `4d377633dd92be40afd167f74c98c2d6debdb97e`,
which includes the final Timeline anchor fix from issue #326.

## Dependency and Platform Contract

- Vite is 8.2.2 and the `@vitejs/plugin-react` 6.1 line resolves to 6.1.1.
- Production JavaScript and CSS target Chrome 107, Edge 107, Firefox 104, and Safari 16.
  This pins the compilation floor instead of inheriting a moving Vite default and covers the
  WebView2/WebKit families used by the supported Windows, macOS, and Linux desktop builds. The same
  artifact powers the browser/PWA client, so Safari 16 is also its explicit iOS compilation floor;
  installed iOS push notifications already require Safari 16.4 or newer.
- The frozen lockfile contains Rolldown 1.2.6 and Lightning CSS 1.33.0 native packages for all six
  release targets: macOS arm64/x64, Linux GNU arm64/x64, and Windows MSVC arm64/x64. A unit
  contract fails if any of those bindings disappears.

## Browser Evidence

The complete development-server suite passed 331/331 tests in one worker under CI retry policy,
with no retry used. The comparison below then ran the strict continuous-resize test and both
predecessor-remount variants ten times each, one worker and zero retries:

| Bundler | Strict Runs | Result | Duration |
| --- | ---: | --- | ---: |
| Vite 6.4.3 | 30 | 30 passed, zero retries | 59.1s |
| Vite 8.2.2 | 30 | 30 passed, zero retries | 1.1m |

The Vite 8 development client reported one Chromium `ResizeObserver loop completed with
undelivered notifications` diagnostic during each of the ten deliberate continuous-resize runs.
Neither predecessor-remount test reported it. Every painted-frame overlap and logical-anchor
invariant still passed, and the same continuous-resize assertion passed from the production preview
without the development client or diagnostic. This is therefore documented as development-client
diagnostic noise for deliberate resize churn, not suppressed or converted into a global browser
error exception.

CI now builds dedicated production Timeline and Settings fixtures, serves the result with
`vite preview`, and runs six browser checks against the emitted JavaScript and CSS. They cover the
strict continuous-resize invariant, both predecessor-remount variants, reduced Settings topology,
and painted Settings affordances in both themes. Tagged selection is contract-checked so deleting a
production marker cannot silently shrink the lane. The validation epoch passed 6/6.

The fixtures use Vite's `production-e2e` mode solely to select isolated HTML entry points and the
`dist-e2e` output directory. No `.env.production` files or `import.meta.env.MODE` consumers are
present in this epoch. If either is introduced, the fixture selector must move to a mode-independent
mechanism so this lane continues to reproduce the shipped production environment.

## Production Output Inspection

The normal application build was inspected before and after the upgrade on the original dependency
comparison base; the rebased snapshot was then rebuilt and browser-verified separately:

| Output | Vite 6.4.3 | Vite 8.2.2 | Assessment |
| --- | ---: | ---: | --- |
| HTML | 4.50 kB | 4.49 kB | Entry structure retained |
| CSS | 245.52 kB (44.62 kB gzip) | 242.66 kB (43.68 kB gzip) | 1.2% smaller; rendered geometry checks pass |
| JavaScript total | 1,910.41 kB (553.79 kB gzip) | 1,872.02 kB (531.23 kB gzip) | 2.0% smaller; lazy highlight chunk retained |

Vite 8 names the lazy Markdown syntax-highlighting chunk explicitly instead of emitting two generic
`index-*` JavaScript chunks. The application entry and lazy chunk remain distinct, all HTML asset
references resolve through `vite preview`, and no unintended CSS or chunk loss was observed.

## Mechanical Gates

- Frozen install: passed.
- Typecheck: passed.
- Unit tests: 4,250 passed, 26 skipped, 0 failed.
- Standard web build and production-fixture build: passed.
- Runner and control-plane bundle-only builds: passed.
- Desktop bundle guards: passed in the full unit suite.
- Package audit at high severity: no known vulnerabilities.
