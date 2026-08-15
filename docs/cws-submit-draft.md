# Chrome Web Store submission draft — Splendid Bookmarks 0.4.0

Paste-ready values for the Developer Dashboard. Every claim here is checked against the
build; `npm run check:store` fails if the repository drifts from it.

Source of truth for the artifact: `builds/splendid-bookmarks-v0.4.0.zip` (42 files,
`manifest.json` at the archive root), built by `npm run zip`.

## Submission record

|                   |                                    |
| ----------------- | ---------------------------------- |
| Item ID           | `ehmdjfhakpifieboiogjemfdbgaemmaj` |
| First submitted   | 2026-08-15, version 0.4.0          |
| Publisher account | `vainful@icloud.com`               |

The item ID is what a later automated upload needs as `EXTENSION_ID`, and it is the id
the public store URL will carry, so it is recorded here rather than looked up again.

---

## Store listing tab

| Field                  | Value                                                                   |
| ---------------------- | ----------------------------------------------------------------------- |
| Item name              | `Splendid Bookmarks`                                                    |
| Summary (132 char max) | see below                                                               |
| Detailed description   | see [cws-listing.md](cws-listing.md)                                    |
| Category               | `Workflow & Planning`                                                   |
| Language               | `English` (plus a `日本語` locale in the listing)                       |
| Store icon             | `extension/icons/icon-128.png` (128x128)                                |
| Screenshots            | `submission-screenshots/01..05` at 1280x800, regenerated per submission |
| Homepage URL           | `https://github.com/aktsmm/splendid-bookmarks`                          |
| Support URL            | `https://github.com/aktsmm/splendid-bookmarks/issues`                   |
| Mature content         | No                                                                      |

Summary:

```text
Tidy bookmarks with a dry run, a verified backup, one-click rollback, a reversible Trash and a confirmed delete.
```

---

## Privacy practices tab

### Single purpose

```text
Splendid Bookmarks reorganises the bookmarks already in your browser. It reads the
bookmark tree, reports duplicates, previews a batch of moves against the live tree, and
applies, verifies, or rolls that batch back. It does one job — placing bookmarks — and it
does it entirely on your own device.
```

### Permission justification — `bookmarks`

```text
The extension exists to reorganise bookmarks, so it needs to read the tree to report
duplicates and build a plan, and to write to it to move the bookmarks you approved.
Writing is limited to four calls: move a bookmark or folder, create the single empty
Trash folder you asked for, rename a bookmark's title, and delete one bookmark by id
after you put it in the Trash and confirmed it. Recursive folder deletion is not used
anywhere in the build.
```

### Permission justification — `storage`

```text
Two records, both local and both required to make the destructive steps reversible. A
journal written while a batch of moves is running records where each bookmark came from,
so an interrupted batch can still be rolled back; it is deleted when the batch is rolled
back. A Trash ledger records what was sent to the Trash folder so a whole batch can be
put back in its original order, and so a permanent delete can refuse an item that no
longer matches its record. Neither leaves the device.
```

### Remote code

```text
No, I am not using remote code.
```

Backing evidence: the manifest declares no host permissions and no background service
worker, the content security policy forbids remote code, and `tests/no-write-api.test.js`
fails the build if any network send appears in the extension source.

### Data usage — what to declare

| Category                            | Declare | Why                                                                                                                           |
| ----------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Personally identifiable information | No      | never read                                                                                                                    |
| Health information                  | No      | never read                                                                                                                    |
| Financial and payment information   | No      | never read                                                                                                                    |
| Authentication information          | No      | never read                                                                                                                    |
| Personal communications             | No      | never read                                                                                                                    |
| Location                            | No      | never read                                                                                                                    |
| Web history                         | No      | the `history` permission is not requested; bookmarks are not browsing history                                                 |
| User activity                       | No      | no clicks, keystrokes, or usage analytics are recorded                                                                        |
| Website content                     | **No**  | the extension reads bookmark titles and URLs through the `bookmarks` API only, never page content, and nothing is transmitted |

The three certifications can all be accepted:

- I do not sell or transfer user data to third parties, outside of the approved use cases — **nothing is transmitted at all**
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose — **the data never leaves the device**
- I do not use or transfer user data to determine creditworthiness or for lending purposes — **not applicable**

### Privacy policy URL

```text
https://github.com/aktsmm/splendid-bookmarks/blob/main/docs/privacy-policy.md
```

That document states the same scope as the table above: nothing is sent to the developer,
to a server, or to a third party, while bookmark reads and two local records are disclosed
explicitly. Keep the two in step — a mismatch between this tab and the policy is a
publisher-level problem, not just an item-level one.

---

## Distribution tab

| Field                   | Value       |
| ----------------------- | ----------- |
| Visibility              | Public      |
| Pricing                 | Free        |
| Geographic distribution | All regions |

---

## Before uploading

- [ ] `npm test`, `npm run check:store`, `npm run check:skills` all green
- [ ] `npm run zip` rebuilt from the tag being released
- [ ] `node scripts/run-pilot.mjs --extension-dir <unzipped build>` returned `PILOT PASS`
- [ ] `node scripts/capture-store-screenshots.mjs --extension-dir <unzipped build>` returned `CAPTURE PASS`
- [ ] every screenshot looked at, no real bookmark titles, URLs, or account names visible
- [ ] the description below was read against the build, and does not claim the extension
      cannot delete bookmarks — it can, after a confirmed two-step flow
