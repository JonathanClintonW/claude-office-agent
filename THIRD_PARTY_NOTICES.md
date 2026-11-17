# Third-party notices

Claude Agent Office is licensed under the [MIT License](LICENSE). It bundles or depends on the third-party components below, each licensed separately under its own terms. Versions are the ones resolved in `package-lock.json` at the time of writing; links and copyright lines are taken from each package's own `package.json` and licence file.

## Bundled in the browser UI and the VS Code webview (`packages/ui`)

| Component | Version | Use | Licence | Copyright (from its licence file) |
| --- | --- | --- | --- | --- |
| [PixiJS](https://pixijs.com) (`pixi.js`) | 8.23.0 | 2D WebGL rendering of the office | MIT | Mathew Groves, Chad Engler |
| [React](https://react.dev) (`react`, `react-dom`, `scheduler`) | 19.3.1 / 0.28.0 | User interface | MIT | Meta Platforms, Inc. and affiliates |
| [eventemitter3](https://github.com/primus/eventemitter3) | 5.0.4 | Used by PixiJS | MIT | Arnout Kazemier |
| [earcut](https://github.com/mapbox/earcut) | 3.2.4 | Used by PixiJS (polygon triangulation) | ISC | Mapbox |
| [colord](https://github.com/omgovich/colord) | 2.13.0 | Used by PixiJS (colour parsing) | MIT | Vlad Shilov |
| [ismobilejs](https://github.com/kaimallea/isMobile) | 1.1.1 | Used by PixiJS (device detection) | MIT | Kai Mallea |
| [parse-svg-path](https://github.com/jkroso/parse-svg-path) | 0.2.0 | Used by PixiJS (SVG paths) | MIT | Jake Rosoman |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | 0.8.15 | Used by PixiJS (XML parsing) | MIT | Christopher J. Brody and other contributors; jindw and other contributors |
| [tiny-lru](https://github.com/avoidwork/tiny-lru) | 11.4.7 | Used by PixiJS (text metrics cache) | BSD-3-Clause | Jason Mulligan |
| [gifuct-js](https://github.com/matt-way/gifuct-js), [js-binary-schema-parser](https://github.com/matt-way/jsBinarySchemaParser) | 2.1.2, 2.0.3 | Dependencies of PixiJS's GIF support; listed for completeness (the office does not load GIFs) | MIT | Matt Way |
| [Pixelify Sans](https://github.com/eifetx/Pixelify-Sans) via `@fontsource/pixelify-sans` | 5.3.0 | UI and label font | SIL Open Font License 1.1 | The Pixelify Sans Project Authors |
| [Silkscreen](https://github.com/googlefonts/silkscreen) via `@fontsource/silkscreen` | 5.3.0 | Headings and badges font | SIL Open Font License 1.1 | The Silkscreen Project Authors |

The PixiJS dependencies are included only as far as the bundler keeps the parts PixiJS uses. Their notices are listed (and shipped) all the same.

## Bundled in the monitor and the VS Code extension (`packages/monitor`, `packages/vscode-extension`)

| Component | Version | Use | Licence | Copyright (from its licence file) |
| --- | --- | --- | --- | --- |
| [ws](https://github.com/websockets/ws) | 8.23.0 | WebSocket server and client | MIT | Einar Otto Stangvik; Arnout Kazemier and contributors |

## Licence texts

- The full licence text of every component is in `node_modules/<package>/LICENSE` (for colord: `LICENSE.md`) after `npm install`.
- The VS Code extension package includes this file, the project `LICENSE`, and the licence text of every component above in `media/ui/licenses/` (the bundles strip licence comments, so the notices travel as separate files).
- Development tools (TypeScript, esbuild, Vite, Vitest, Playwright, jsdom and others) are used to build and test the project and are not shipped in its bundles.

## Original artwork

All pixel art (characters, furniture, rooms, icons) is original and drawn procedurally in code (`packages/ui/src/office/pixelArt.ts` and `roomArt.ts`). It contains no third-party image assets. The README screenshots and animations in `docs/assets/screenshots/` were captured from the app itself with simulated demo data.

Claude and Claude Code are products of Anthropic. This project is independent and is not affiliated with, endorsed by or sponsored by Anthropic.
