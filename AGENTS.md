# AGENTS.md — SVD Image Compression

## Collaboration

- The user is the developer; act as a programming tutor and discussion partner.
- Communicate in German. Use English for code, comments, UI and repository text.
- Assume HTML, CSS, Python and JavaScript basics. Explain project-specific logic
  intuitively, then technically, without a beginner curriculum.
- Give focused, usable code when implementation help is requested; do not require
  a hint ladder. Showing code does not authorize changing repository files.
- Do not create, edit, move or delete files, install dependencies or change project
  state unless explicitly authorized. Do not automatically apply review fixes.
- Work on one meaningful step at a time. Review the user's code as written;
  distinguish bugs, potential problems and optional improvements.
- Explain meaningful dependency/architecture trade-offs before changing them.
- For teaching responses, finish with one concrete next action. Keep explanations
  concise; the user's understanding matters more than rushing completion.

## Keep the repository minimal

- Keep only the live website, README.md, its screenshots, this file and essential
  Git metadata. The bilingual README was explicitly requested.
- Do not add test suites, test fixtures, historical versions, example source code,
  dependency manifests, build pipelines or separate documentation files unless
  the user explicitly requests them. Verify changes without retaining test code.
- There is no bundled example image. README screenshots are documentation assets
  explicitly requested by the user; retain only an up-to-date desktop capture.
- Keep necessary English comments; avoid unused helpers, diagnostics and
  abstractions. Preserve the source/license notices in README.md.
- The current cleanup was explicitly authorized; it does not authorize unrelated
  future changes. Explain GitHub Pages publication in conversation when asked,
  rather than creating a deployment guide.

## Architecture and numerical rules

- `docs/` is the complete static GitHub Pages application, with relative URLs.
- JavaScript handles UI, worker communication and SVG presentation. Python in
  `docs/python/` owns image processing and compression calculations.
- A module worker runs pinned Pyodide 314.0.8 with NumPy/Pillow. No backend, cloud
  computation, frontend framework, database or build pipeline is needed.
- Preserve the custom direct SVD: Householder bidiagonalization followed by
  implicit shifted bidiagonal QR with Givens rotations. No Gram matrix, library
  SVD/eigendecomposition/QR routine or pseudoinverse substitute.
- NumPy arithmetic primitives are allowed. The QR implementation extends the
  lecture foundations; retain its public-domain JAMA/LINPACK attribution.
- Pillow applies EXIF orientation, composites alpha on white, converts to grayscale
  and resizes with Lanczos. Divide intensities by 255.0, not image-specific min/max.
- Reconstruct and measure error in floating point. Clip only for export, then
  scale by 255, round and convert to uint8. Do not hide errors by clipping first.
- Keep the SVD cached across rank edits; invalidate it on image/resolution changes.
  Cancellation terminates the worker, with safe source restoration on retry.
- Resource limits live in main.js and are passed to Python. Keep message fields,
  shapes and limits consistent. User-selected images must remain in the browser.

## Preserve the website functions

- Local image upload, grayscale preview and logarithmic spectrum.
- Exactly three independent integer ranks, plus a fourth recommended image.
- Resolution choices 64, 128, 512 and Original, preserving aspect ratio without
  upscaling. Disable non-shrinking choices and validate ranks before submission.
- Recommend the smallest rank with measured relative Frobenius error <= 5%.
  Use tail energy to locate it, then verify actual error and the predecessor.
- Four PNG downloads. Keep two distinct metrics: "PNG file savings" compares actual
  PNG bytes with the processed grayscale reference; "SVD value savings" compares
  k(height + width + 1) scalar values with height × width. The latter assumes equal
  bytes per value and excludes encoding/overhead. Show increases for either metric;
  never present the scalar-count estimate as actual PNG or factor-file bytes.
- Use the spectrum panel for the chart without a numerical-threshold count caption.
- Preserve a basic desktop grid; there is no mobile view or responsive view
  switching. Keep HTML/CSS minimal, without decorative badges, explanatory hints,
  placeholder text or extra subheadings. Keep the image labels, spectrum title,
  status/error messages and rank bounds as explicitly chosen by the user.
- Keep basic fonts, sizes, colors and borders. Allow scrolling if a viewport is
  smaller than the desktop layout instead of adding mobile-specific styling.
