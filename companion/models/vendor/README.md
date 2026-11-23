# Optional Proprietary Runtime: Live2D Cubism Core for Web

This directory is intentionally empty in the public open-source Git repository because
`live2dcubismcore.min.js` is proprietary software owned by Live2D Inc. (not MIT and not CC BY 4.0).

## How to enable full Live2D rendering when building from source

1. Visit the official Live2D download page: https://www.live2d.com/en/sdk/download/web/
2. Read and accept the **Live2D Proprietary Software License Agreement**, then download
   `Cubism SDK for Web` (verified with `CubismSdkForWeb-5-r.5`, Core `06.00.0001`).
3. Extract the archive and place these files into this folder (`companion/models/vendor/`):
   - `live2dcubismcore.min.js` (from `Core/live2dcubismcore.min.js`)
   - `CORE-LICENSE.md` (renamed from `Core/LICENSE.md`)
   - `RedistributableFiles.txt` (from `Core/RedistributableFiles.txt`)

## Running without Live2D Cubism Core

If `live2dcubismcore.min.js` is not present, Companion still builds and runs cleanly and
automatically falls back to the 2D Xiaofan mascot stage.

Do not commit `live2dcubismcore.min.js` to any public Git repository.
