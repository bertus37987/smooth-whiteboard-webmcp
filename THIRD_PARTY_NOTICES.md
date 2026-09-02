# Third-party notices

Smooth Handwriting bundles `ink-stroke-modeler-ts`, a TypeScript
reimplementation of Google's Ink Stroke Modeler:

- TypeScript port: https://github.com/WhiteboardCX/ink-stroke-modeler-ts
- Original project: https://github.com/google/ink-stroke-modeler
- Original copyright: Copyright 2022 Google LLC
- License: Apache License 2.0

The port is pinned to commit
`240d80f2c78c2f70317b498d37564f90fcddfe0c`. It runs entirely on-device and
does not transmit handwriting data.

## Bundled fonts

The web app self-hosts two Latin-subset variable fonts under `web/fonts/`, so an
agent-drawn board looks the same on every machine instead of falling back to
whatever handwriting face the operating system happens to have:

- Inter — Copyright 2016 The Inter Project Authors
  (https://github.com/rsms/inter)
- Caveat — Copyright 2015 Impallari Type
  (https://github.com/googlefonts/caveat)

Both are licensed under the SIL Open Font License, Version 1.1
(https://openfontlicense.org). The files are the unmodified Latin subsets served
by Google Fonts and are used only to render text; no font data is transmitted.
