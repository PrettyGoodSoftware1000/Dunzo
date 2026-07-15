# Dunzo end-to-end test

Runs the real app in headless Chromium with an in-memory Firebase stub
(no network, no real Firebase project touched) and verifies the full
data-safety cycle:

create trackables + category + countdown + whiteboard text/image/link
→ Export data (JSON + RTF, checking whiteboard content is included)
→ dev-menu "Clear Firebase data" wipe
→ re-import the JSON → everything restored in the UI.

Run with a static server on port 8905 from the repo root:

    python3 -m http.server 8905 &
    npm install playwright   # once
    node test/e2e-test.mjs
