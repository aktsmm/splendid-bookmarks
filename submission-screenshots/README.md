# Store screenshots

Generated, not hand-made. Run:

```powershell
node scripts/capture-store-screenshots.mjs --extension-dir <unzipped build> --lang en
```

The script launches a throwaway profile, refuses to continue if that profile already
holds a bookmark, seeds a small synthetic set (`example.com`, MDN, Chrome Extensions
docs), forces the browser UI language to match `--lang` so folder names are not a
different language from the extension, and captures at exactly 1280x800 — the size the
Chrome Web Store requires.

The PNGs themselves are not tracked. Regenerate them before a submission rather than
keeping a stale copy in the repository, and look at every frame before uploading: this
extension displays bookmark titles and URLs, so a capture taken in the wrong profile
would publish somebody's real browsing.
