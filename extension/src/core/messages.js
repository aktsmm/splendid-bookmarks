/**
 * UI message catalog. Single source of truth for both the page UI and the
 * `_locales` files used by the manifest; tests/i18n.test.js keeps them in sync.
 */

export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "ja"];

/** Keys the manifest references through `__MSG_<key>__`. */
export const MANIFEST_KEYS = [
  "extensionName",
  "extensionDescription",
  "actionTitle",
];

export const MESSAGES = {
  en: {
    extensionName: "Splendid Bookmarks",
    extensionDescription:
      "Tidy bookmarks safely: dry run, verified backup, rollback, a reversible Trash folder, and a confirmed two-step delete.",
    actionTitle: "Splendid Bookmarks",

    "ui.language": "Language",
    "ui.badge.writeScope":
      "It moves bookmarks and folders, renames a bookmark when a plan asks it to, creates the one Trash folder you ask for, and deletes only what you confirm from the Trash",
    "ui.intro":
      "Load the tree first — that unlocks the rest. Export a snapshot and re-select it before applying anything; that backup is what makes the batch reversible.",
    "ui.popup.badge": "Move first, delete last",
    "ui.popup.note":
      "This build moves bookmarks and folders, and can rename a bookmark when a loaded plan asks for it. It never changes a URL or renames a folder, and it only deletes items you have sent to the Trash and confirmed.",
    "ui.popup.open": "Open manager",

    "section.quickstart.title": "Start here",
    "section.quickstart.note":
      "New here? This runs both buttons in step 1 for you: it reads your bookmarks and saves a backup file. Nothing else runs, and nothing is moved until you pick the moves in step 3 and re-select that backup in step 4.",
    "section.quickstart.run": "Load the tree and save a backup",
    "section.tree.title": "1. Live tree",
    "section.tree.load": "Load tree",
    "section.tree.export": "Export snapshot",
    "section.duplicates.title": "2. Duplicate report",
    "section.duplicates.mode": "Detection mode",
    "section.duplicates.mode.normalized":
      "Normalized URL (ignores tracking params, trailing slash, www)",
    "section.duplicates.mode.exact": "Exact URL",
    "section.duplicates.run": "Find duplicates",
    "section.duplicates.send": "Send the rest to step 3",
    "section.duplicates.hint":
      'Pick the one copy to keep in each group, then send the rest to step 3 and move them into a folder you keep them in. This step only moves them; nothing is deleted here. Create that folder yourself in your browser\'s bookmark manager first (for example "Duplicates (review)"), reload the tree, then choose it under "Move them into" in step 3.',
    "section.agent.title": "7. AI agent handoff (optional)",
    "section.agent.note":
      "Optional. Steps 1-5 work without an agent. If you want one to plan the moves, give it the context file and the prompt below; both are generated from the tree you just loaded.",
    "section.agent.export": "Export agent context (JSON)",
    "section.agent.scope": "Bookmarks to place",
    "section.agent.scope.all": "Everything in the profile",
    "section.agent.copyHint":
      "Select the text below and copy it yourself — this extension never touches your clipboard.",
    "agent.stats":
      "{bookmarks} bookmarks / {folders} folders / {boundaries} boundary group(s)",
    "agent.scope.summary":
      "Scoped to {scope}: {bookmarks} of {total} bookmarks are handed to the agent.",
    "agent.scope.changed":
      "The scope changed after the last export. Export the agent context again so the file matches this prompt.",
    "agent.ambiguous.none": "All folder paths are unique.",
    "agent.ambiguous.some":
      "{count} folder paths are ambiguous — the agent must send destinationFolderId for those.",
    "agent.export.done":
      "Agent context exported: {filename} ({bytes}, sha256={digest}).",
    "section.plan.title": "3. Moves to apply",
    "section.plan.note":
      "Pick the moves yourself, or load a plan an agent produced. Either way the same Dry Run checks them against the live tree.",
    "section.plan.manual": "Pick the moves yourself",
    "section.plan.source": "Look in",
    "section.plan.filter": "Filter by title or URL",
    "section.plan.destination": "Move them into",
    "section.plan.destination.none": "Choose a folder",
    "section.plan.build": "Use this selection",
    "section.plan.clear": "Clear selection",
    "section.plan.fromFile": "Load an agent plan",
    "section.plan.file": "Agent plan file (JSON)",
    "section.plan.run": "Validate / Dry Run",

    "builder.reason": "picked by hand",
    "builder.selected.title": "Selected",
    "builder.candidates.title": "Everything else",
    "builder.candidates.none": "Nothing matches the current folder and filter.",
    "builder.truncated":
      "Showing the first {shown} of {total}. Narrow the folder or the filter to see the rest.",
    "builder.status.none": "Tick the bookmarks and folders you want to move.",
    "builder.status.selected": "{count} selected.",
    "builder.status.selectedNeedsDestination":
      "{count} selected. Now choose the folder to move them into.",
    "builder.status.stale":
      "Part of the selection is no longer in the tree. Clear it and pick again.",
    "builder.status.needsDestination": "Choose the folder to move them into.",
    "builder.status.built":
      "{count} moves are ready. The Dry Run below checked them.",
    "builder.status.builtDropped":
      "{count} moves are ready. {dropped} were left out because a selected folder already takes them along.",
    "section.apply.title": "4. Apply",
    "section.apply.note":
      "Apply moves only the operations the Dry Run cleared, one at a time, and stops at the first sign that anything else changed the bookmarks.",
    "section.apply.backup": "Re-select the snapshot you exported in step 1",
    "section.apply.button.apply": "Apply approved moves",
    "section.apply.button.verify": "Verify result",
    "section.apply.button.rollback": "Roll back last batch",
    "section.restore.title": "5. Restore from a snapshot",
    "section.restore.note":
      "Works even after the extension has been reinstalled: the snapshot file is the only input. Every node is matched individually before it moves, and the title is part of that match, so a bookmark renamed since the snapshot is skipped rather than moved.",
    "section.restore.file": "Snapshot file (JSON)",
    "section.restore.run": "Restore positions",
    "section.trash.title": "6. Trash",
    "section.trash.note":
      "Sending to Trash moves bookmarks into a folder you choose; that move deletes nothing, and a whole batch can be put back in its original order while the items are still there. Deleting them for good is a separate, confirmed step below, and it cannot be undone.",
    "section.trash.folder": "Trash folder",
    "section.trash.use": "Use",
    "section.trash.none": "Choose a folder",
    "section.trash.createIn": "Or create one in",
    "section.trash.name": "Named",
    "section.trash.create": "Create it",
    "section.trash.actions": "Send and put back",
    "section.trash.send": "Send the selection from step 3 to Trash",
    "section.trash.restore": "Put the last batch back",
    "section.trash.forget": "Forget the recovery records",
    "section.trash.empty": "Delete for good",
    "section.trash.emptyNote":
      "This cannot be undone. Only items this extension put in the Trash folder are deleted, one at a time, and the run stops at the first item that no longer matches its record. A verified backup from step 1 is required.",
    "section.trash.emptyConfirm": "I understand these bookmarks will be gone",
    "section.trash.emptyRun": "Delete the trashed items for good",
    "trash.status.deleted":
      "Deleted {count} for good. They cannot be brought back by this extension.",
    "trash.status.created": "Created {title}. It is now the Trash folder.",
    "trash.status.sent": "Sent {count} to the Trash folder.",
    "trash.status.restored": "Put {count} back in the order they were taken.",
    "trash.status.forgotten":
      "Forgot {count} recovery records. The bookmarks are still in the Trash folder; only the record of where they came from is gone.",
    "trash.status.working": "Working: {done} of {total}.",
    "trash.status.failed": "The Trash operation failed: {message}",
    "trash.status.empty": "No recovery records yet.",
    "trash.status.unreadable":
      "The stored Trash records could not be read ({reason}). They have been left untouched, and sending or restoring is disabled so a newer version's records are not overwritten.",
    "trash.status.quarantined":
      "{count} damaged records were set aside. Bookmarks they name cannot be put back until you forget them.",
    "trash.panel.title": "Recovery records",
    "trash.column.item": "Bookmark",
    "trash.column.state": "State",
    "trash.column.origin": "Taken from",
    "trash.column.batch": "Batch",
    "trash.column.retention": "Retention",
    "trash.state.pending": "not confirmed",
    "trash.state.trashed": "in Trash",
    "trash.state.restoring": "being put back",
    "trash.state.restored": "put back",
    "trash.state.deleting": "being deleted",
    "trash.state.deleted": "deleted for good",
    "trash.state.orphaned": "no longer found",
    "trash.state.failed": "needs attention",
    "trash.retention.active": "labelled until {date}",
    "trash.retention.expired":
      "label expired; still restorable while the item is there",

    "apply.backup.checking": "Checking the snapshot...",
    "apply.backup.ok":
      "Backup verified: {filename} (sha256={digest}). Apply is unlocked.",
    "apply.backup.digestMismatch":
      "This file is not the snapshot that was exported for this tree.",
    "apply.backup.treeMismatch":
      "This snapshot was taken from a different tree state. Export a fresh one.",
    "apply.backup.failed": "The snapshot could not be checked: {message}",
    "apply.resume.notApplied":
      "the move was never carried out, so it was left alone",
    "apply.resume.conflict":
      "the node is neither where it started nor where it was being put",
    "apply.status.approved":
      "{count} operations approved. Verify the backup to unlock Apply.",
    "apply.status.pending":
      "A batch from an earlier session is still open: {count} moves can be verified or rolled back.",
    "apply.status.running": "Applying {done} of {total}...",
    "apply.status.done": "Applied {count} operations.",
    "apply.status.aborted": "Batch stopped: {message}",
    "apply.status.rollingBack": "Rolling back {done} of {total}...",
    "apply.status.rolledBack": "Rolled back {count} operations.",
    "apply.status.verified":
      "Verified: {ok} of {total} moves are exactly where they were put.",
    "apply.status.verifyFailed":
      "Verification found {count} moves that are not where they were put.",
    "apply.drift.title": "What changed outside this batch",
    "apply.drift.id": "id",
    "apply.drift.field": "field",
    "apply.drift.expected": "expected",
    "apply.drift.actual": "actual",
    "apply.drift.truncated":
      "Showing the first {shown} of {total} differences.",
    "apply.col.opId": "opId",
    "apply.col.status": "status",
    "apply.col.expected": "expected position",
    "apply.col.actual": "actual position",
    "verify.verified": "as placed",
    "verify.position-mismatch": "moved since",
    "verify.title-mismatch": "renamed since",
    "verify.missing": "gone",
    "verify.not-applied": "not applied",

    "restore.status.checking": "Checking the snapshot...",
    "restore.status.rejected":
      "This snapshot does not match this profile ({matched} of {total} nodes agree).",
    "restore.status.ready":
      "{moves} nodes would be put back, {skipped} skipped.",
    "restore.status.nothing":
      "Every node is already where the snapshot recorded it.",
    "restore.status.running": "Restoring {done} of {total}...",
    "restore.status.done": "Restored {count} nodes.",
    "restore.status.failed": "Restore stopped: {message}",
    "restore.skipped.title": "Skipped nodes",
    "restore.moves.title": "Moves this restore will make",
    "restore.moves.from": "from",
    "restore.moves.to": "to",
    "restore.skipped.id": "id",
    "restore.skipped.reason": "reason",

    "tree.status.loading": "Loading...",
    "tree.status.loaded": "Loaded {count} nodes",
    "tree.status.failed": "Load failed: {message}",
    "tree.stat.item": "Item",
    "tree.stat.value": "Value",
    "tree.stat.urls": "URLs",
    "tree.stat.folders": "Folders",
    "tree.stat.depth": "Max depth",
    "tree.stat.digest": "treeDigest (SHA-256)",
    "tree.stat.browser": "Browser",
    "tree.stat.boundary": "Boundary signal (syncing)",
    "tree.boundary.available": "available",
    "tree.boundary.missing": "not reported — applying is refused",
    "tree.roots.title": "Permanent roots",
    "tree.roots.id": "id",
    "tree.roots.title.column": "title",
    "tree.roots.folderType": "folderType",
    "tree.roots.syncing": "syncing",
    "tree.roots.children": "direct children",
    "tree.roots.subtree": "bookmarks in subtree",
    "tree.export.done":
      "Snapshot exported: {filename} ({bytes}, sha256={digest}). The page cannot confirm the file reached your disk, so you have to re-select it in step 4 before anything can be applied.",

    "duplicates.summary":
      "{mode} mode: {groups} groups / {count} duplicate entries",
    "duplicates.mode.normalized": "Normalized",
    "duplicates.mode.exact": "Exact",
    "duplicates.unparsable":
      "Entries that could not be parsed as URLs: {count} (excluded from detection)",
    "duplicates.col.id": "id",
    "duplicates.col.path": "path",
    "duplicates.keep.legend": "Keep one copy of {key}",
    "duplicates.groups.truncated":
      "Showing the first {shown} of {total} groups.",
    "duplicates.groups.showAll": "Show all {total} groups",
    "duplicates.group.truncated":
      "Showing the first {shown} of {total} copies — this group cannot be sent until they are all shown.",
    "duplicates.group.showAll": "Show all {total} copies",
    "duplicates.status.summaryPick":
      "{mode} mode: {groups} groups / {count} duplicate entries. Pick the one copy to keep in each group, then choose a destination in step 3.",
    "duplicates.status.summaryDestination":
      '{mode} mode: {groups} groups / {count} duplicate entries. Now choose the folder to move them into, under "Move them into" in step 3.',
    "duplicates.none":
      "No duplicates in this profile under the current detection mode.",
    "duplicates.status.sent": "{count} added to the selection in step 3.",
    "duplicates.status.sentNone":
      "Nothing was added — see the reasons at the top of the report.",
    "duplicates.sent.title": "Last send",
    "duplicates.sent.added": "Added to the selection in step 3: {count}",
    "duplicates.skip.no-keeper": "no copy was chosen to keep: {count}",
    "duplicates.skip.stale-keeper":
      "the copy chosen to keep is no longer in the tree: {count}",
    "duplicates.skip.truncated":
      "not every copy in the group is shown yet: {count}",
    "duplicates.skip.already-there":
      "already inside the destination folder: {count}",
    "duplicates.skip.boundary":
      "on the other side of the account/local boundary, or the boundary cannot be proven: {count}",
    "duplicates.skip.limit":
      "over the {limit} per-batch limit — apply this batch, reload the tree, then send again: {count}",

    "plan.status.loaded":
      "Plan loaded: {count} operations / planDigest={digest}",
    "plan.status.loading": "Reading the plan file...",
    "plan.status.invalid": "Schema validation failed: {count} errors",
    "plan.status.tooLarge":
      "This plan has {count} operations and one batch is limited to {limit}. Split it and run the parts separately.",
    "plan.status.failed": "Load failed: {message}",
    "plan.error.path": "path",
    "plan.error.message": "message",
    "plan.errors.truncated": "Showing the first {shown} of {total} problems.",
    "dryRun.col.opId": "opId",
    "dryRun.col.kind": "operation",
    "dryRun.col.status": "status",
    "dryRun.col.current": "current path",
    "dryRun.col.destination": "destination or new title",
    "dryRun.kind.move": "move",
    "dryRun.kind.rename": "rename",
    "dryRun.rename.to": 'rename to "{title}"',
    "dryRun.col.detail": "detail",
    "dryRun.col.reason": "reason",
    "dryRun.col.confidence": "confidence",
    "dryRun.summary.category": "classification",
    "dryRun.notes": "Agent notes: {notes}",
    "dryRun.truncated":
      "Showing the first {shown} of {total} rows. The counts above cover every operation.",
    "dryRun.summary.count": "count",
    "dryRun.totals":
      "{movable} movable / {blocked} blocked (only movable operations are applied)",
    "dryRun.status.clean":
      "Dry Run finished: nothing blocked ({movable} movable)",
    "dryRun.status.blocked":
      "Dry Run finished: {count} operations cannot be applied",

    "status.movable": "movable",
    "status.no-op": "no-op",
    "status.duplicate-op": "duplicate operation",
    "status.unsupported-op-type": "unsupported type",
    "status.id-not-found": "id not found",
    "status.permanent-root-source": "permanent root",
    "status.unmodifiable-node": "unmodifiable node",
    "status.title-mismatch": "title mismatch",
    "status.url-mismatch": "url mismatch",
    "status.current-path-mismatch": "current path mismatch",
    "status.rename-not-a-bookmark": "folders cannot be renamed",
    "status.rename-unchanged": "title already matches",
    "status.rename-too-long": "new title too long",
    "status.rename-trash-managed": "item is in the Trash ledger",
    "status.destination-not-found": "destination not found",
    "status.destination-ambiguous": "destination ambiguous",
    "status.destination-id-not-found": "destination id not found",
    "status.destination-not-folder": "destination is not a folder",
    "status.destination-conflict": "destination conflict",
    "status.destination-unmodifiable": "destination unmodifiable",
    "status.destination-is-descendant": "destination is a descendant",
    "status.boundary-violation": "boundary violation",
    "status.boundary-indeterminate": "boundary indeterminate",
    "status.operation-interdependent": "operations interfere",

    "detail.movable": "preconditions satisfied",
    "detail.noOp": "already in the destination folder",
    "detail.duplicateOp":
      "the same bookmarkId appears in more than one operation",
    "detail.unsupportedType": 'unsupported operation type "{type}"',
    "detail.permanentRootSource": "permanent root folders cannot be moved",
    "detail.unmodifiableNode": "the node is unmodifiable ({reason})",
    "detail.idNotFound": "bookmarkId does not exist in the live tree",
    "detail.titleMismatch": 'live title is "{liveTitle}"',
    "detail.urlMismatch": "live url is {liveUrl}",
    "detail.urlMismatchFolder": "the live node is a folder, not a bookmark",
    "detail.currentPathMismatch":
      "the bookmark has already moved since the plan was generated",
    "detail.renameNotABookmark":
      "this version renames bookmarks only; a folder title is part of the path every node under it is matched by",
    "detail.renameUnchanged": "newTitle is already the live title",
    "detail.renameTooLong":
      "newTitle is {count} characters, over the {limit} allowed",
    "detail.renameTrashManaged":
      "the Trash ledger still holds a record for this bookmark, and the title is part of what that record matches on",
    "detail.destinationNotFound":
      "destinationPath does not resolve to any folder",
    "detail.destinationAmbiguous":
      "destinationPath resolves to {count} folders",
    "detail.destinationIdNotFound":
      "destinationFolderId does not exist in the live tree",
    "detail.destinationNotFolder": "destinationFolderId is not a folder",
    "detail.destinationConflict":
      "destinationFolderId and destinationPath point at different folders",
    "detail.destinationUnmodifiable":
      "the destination is unmodifiable ({reason})",
    "detail.destinationIsDescendant":
      "the destination is the folder itself or one of its descendants",
    "detail.boundaryIndeterminate":
      "the account/local boundary cannot be proven on this runtime",
    "detail.boundaryViolation":
      "crosses the account/local boundary ({from} -> {to})",
    "detail.operationInterdependent":
      "another operation in this plan moves this node, its destination, or the folder it would land in",

    "schema.notObject": "the plan must be a JSON object",
    "schema.version": "version must be {expected}",
    "schema.generatedAt": "generatedAt must be a string when present",
    "schema.generatedBy": "generatedBy must be a string when present",
    "schema.notes": "notes must be a string when present",
    "schema.unknownField":
      'unknown field "{field}"; the plan schema allows no extra properties',
    "schema.operations": "operations must be an array",
    "schema.tooManyOperations":
      "operations has {count} entries, over the {limit} limit for one plan",
    "schema.operationNotObject": "the operation must be an object",
    "schema.opId": "opId must be a non-empty string",
    "schema.opIdDuplicate": 'duplicate opId "{opId}"',
    "schema.type": 'type must be "move", or "update" in a version 2 plan',
    "schema.bookmarkId": "bookmarkId must be a non-empty string",
    "schema.expectedTitle": "expectedTitle must be a string",
    "schema.expectedUrl": "expectedUrl must be a string or null",
    "schema.currentPath": "currentPath must be an array of strings",
    "schema.newTitle":
      "newTitle must be a non-empty string of at most {limit} characters",
    "schema.destinationPath":
      "destinationPath must be a non-empty array of strings",
    "schema.destinationFolderId":
      "destinationFolderId must be a string when present",
    "schema.reason": "reason must be a non-empty string",
    "schema.confidence": "confidence must be a number between 0 and 1",

    "apply.reject.noApproval": "no approved Dry Run is available",
    "apply.reject.planChanged": "the plan file changed after it was approved",
    "apply.reject.treeChanged":
      "the bookmark tree changed after the Dry Run was approved",
    "apply.reject.noBackup": "the backup has not been verified",
    "apply.reject.opNoLongerMovable":
      "operation {opId} is no longer movable against the current tree",
    "apply.reject.noJournal": "no batch journal is available",
    "apply.reject.journalPlanMismatch":
      "the journal belongs to a different plan",
    "apply.reject.journalBackupMismatch":
      "the journal belongs to a different backup",
    "apply.reject.journalUnusable":
      "The saved batch record could not be read ({reason}), so it was ignored instead of being replayed. It has been left in place; Restore from a snapshot can put moved bookmarks back, but it matches on the title, so it cannot undo a rename.",
    "apply.reject.batchPending":
      "An earlier batch can still be rolled back. Roll it back, or verify it, before applying another.",
    "apply.quarantine.landed":
      "The copies were moved into {path}. This step deletes nothing, so open your browser's own bookmark manager if you want to review or remove what is in there.",

    "apply.abort.externalChange":
      "something outside this batch changed the bookmarks ({kind})",
    "apply.abort.foreignMove":
      "a move this batch did not ask for was reported ({id})",
    "apply.abort.treeDrift":
      "the tree no longer matches what this batch expected",
    "apply.abort.preconditionLost":
      "the operation stopped being applicable ({status})",
    "apply.abort.movedNodeGone": "the node disappeared during the batch",
    "apply.abort.foreignRemoval":
      "something else deleted {id} while this batch was running",
    "delete.abort.noSnapshot":
      "deletion needs a verified backup, and none was confirmed",
    "delete.abort.notTrashed": "{id} is not a record of a trashed item",
    "delete.abort.gone": "{id} is no longer in the tree",
    "delete.abort.notBookmark": "{id} is not a deletable bookmark",
    "delete.abort.identityMismatch":
      "{id} no longer matches the record, so it was not deleted",
    "delete.abort.leftTrash":
      "{id} is no longer in the Trash folder, so it was not deleted",
    "delete.abort.boundary":
      "the account/local store of that item could not be proven",
    "delete.abort.stillPresent":
      "the browser still reports {id} after the delete, so the batch stopped",
    "trash.abort.nodeGone": "{id} is no longer in the tree",
    "trash.create.invalidParent": "the Trash folder cannot be created there",
    "trash.create.boundaryUnknown":
      "this browser did not report which store that location belongs to, so a Trash folder there could not give items back",
    "trash.create.unverified":
      "the folder was not found where it was asked for, so it was not adopted as the Trash folder. A folder with id {id} may have been left behind; the extension will not remove it for you, so delete it yourself if you do not want it.",
    "trash.abort.notBookmark":
      "{id} is not a movable bookmark, and this version moves bookmarks only",
    "trash.abort.destinationInvalid":
      "the chosen Trash folder is not a folder this extension may move into",
    "trash.abort.alreadyInTrash": "{id} is already in the Trash folder",
    "trash.abort.boundary":
      "the Trash folder is on the other side of the account/local boundary",
    "trash.abort.capacity":
      "the Trash records are full ({verdict}). Restore or forget some entries first; forgetting drops the recovery details and leaves the bookmarks where they are.",
    "restore.abort.notExact":
      "this batch can no longer be put back as one ({verdict})",
    "restore.abort.preconditionLost":
      "the item stopped being restorable ({verdict})",
    "restore.abort.receiptGone": "the record for {id} is no longer available",
    "apply.abort.boundaryLost":
      "the account/local boundary no longer holds for this move",
    "apply.abort.landedElsewhere":
      "the browser placed the node at index {index} instead",
    "apply.abort.rollbackConflict":
      "{opId} could not be put back at its exact original position",
    "apply.abort.movedSinceApply":
      "{opId} is no longer where this batch put it, so it was not moved back",
    "apply.abort.changedSinceApply":
      "{opId} no longer carries the title this batch wrote, so it was not renamed back",
    "apply.abort.titleNotWritten":
      'the browser reports the title as "{title}" after the rename',
    "apply.abort.restoreUnauthorised":
      "{id} stopped matching the snapshot between the preview and the restore",
    "apply.abort.failed": "the batch failed: {message}",

    "agent.error.unknownCommand": "that command is not part of this API",
    "agent.error.inputNotObject": "{command} takes an object, or nothing",
    "agent.error.unknownField": '{command} does not accept a "{field}" field',
    "agent.error.query": "search needs a non-empty query string",
    "agent.error.limit": "{command} takes a limit between 1 and {limit}",
    "agent.error.planNotObject": "loadPlan takes the plan document itself",
    "agent.error.tooManyOperations":
      "the plan carries {count} operations, over the {limit} allowed",
    "agent.error.noTree": "load the tree first",
    "agent.error.notReady":
      'the page is refusing that right now; "{control}" is disabled, and the API does not reach past it',
    "agent.error.failed": "the command failed: {message}",
    "agent.error.busy":
      "another command is still running; this API runs one at a time",

    "snapshot.kind": 'kind must be "{expected}"',
    "snapshot.version": "version must be {expected}",
    "snapshot.treeDigest": "treeDigest must be a non-empty string",
    "snapshot.nodes": "nodes must be an array",
    "snapshot.tooManyNodes":
      "nodes has {count} entries, over the {limit} limit for one snapshot",
    "snapshot.nodeNotObject": "each node must be an object",
    "snapshot.nodeId": "id must be a non-empty string",
    "snapshot.nodeParentId": "parentId must be a non-empty string",
    "snapshot.nodeIndex": "index must be a non-negative integer",
    "snapshot.nodeTitle": "title must be a string",
    "snapshot.nodeUrl": "url must be a string or null",

    "restore.skip.nodeMissing": "the node no longer exists",
    "restore.skip.nodeMismatch":
      "the live node does not match the snapshot record",
    "restore.skip.parentMissing": "the folder it belongs in no longer exists",
    "restore.skip.parentMismatch":
      "the folder it belongs in does not match the snapshot record",
    "restore.skip.ancestorMismatch":
      "a folder on the destination path does not match the snapshot record",
    "restore.skip.unmodifiable": "the node is unmodifiable",
    "restore.skip.boundary":
      "putting it back would cross the account/local boundary",
    "restore.skip.boundary":
      "putting it back would cross the account/local boundary",

    "error.bookmarksUnavailable":
      "The bookmarks API is unavailable. Open this page from the installed extension.",
    "error.fileRead": "The file could not be read ({detail}).",
    "error.fileTooLarge":
      "The plan file is {sizeBytes}, which is over the {limitBytes} limit. Pick the plan file, not a full export.",
    "error.exportFailed": "Export failed: {message}",
    "error.storageUnavailable":
      "Extension storage is unavailable, so the batch journal cannot be kept.",
    "error.trashLedgerConflict":
      "Another tab changed the Trash records while this change was being saved. Reload and try again.",
    "error.locksUnavailable":
      "This runtime has no Web Locks API, so other tabs cannot be excluded.",
    "error.applyLockBusy":
      "Another tab of this extension is running a batch. Finish it there first.",
    "browser.edge": "Microsoft Edge",
    "browser.chrome": "Google Chrome",
    "browser.other": "Other Chromium browser",
  },

  ja: {
    extensionName: "Splendid Bookmarks",
    extensionDescription:
      "Dry Run とバックアップ検証のうえで移動を適用します。Trash へ送った項目はバッチ単位で元の並び順のまま戻せます。永続削除は確認付きの別ステップです。",
    actionTitle: "Splendid Bookmarks",

    "ui.language": "表示言語",
    "ui.badge.writeScope":
      "ブックマークとフォルダーの移動、計画が指示した場合のブックマーク改名、依頼された Trash フォルダーの作成、Trash から確認した項目の削除だけを行います",
    "ui.intro":
      "まずツリーを読み込むと以降が使えます。適用前にスナップショットを書き出して再選択してください。そのバックアップがバッチを元に戻せる根拠になります。",
    "ui.popup.badge": "まず移動、削除は最後",
    "ui.popup.note":
      "このビルドはブックマークとフォルダーを移動し、読み込んだ計画が指示した場合はブックマークを改名します。URL の変更とフォルダーの改名は行わず、削除するのは Trash へ送って確認した項目だけです。",
    "ui.popup.open": "マネージャーを開く",

    "section.quickstart.title": "はじめに",
    "section.quickstart.note":
      "初めての方はこちら。1 の 2 つのボタンをまとめて実行し、ブックマークを読み込んでバックアップファイルを保存します。それ以外は実行せず、3 で移動を選び、4 でそのバックアップを選び直すまで、何も移動しません。",
    "section.quickstart.run": "ツリーを読み込んでバックアップを保存",
    "section.tree.title": "1. ライブツリー",
    "section.tree.load": "ツリーを読み込む",
    "section.tree.export": "スナップショットを書き出す",
    "section.duplicates.title": "2. 重複レポート",
    "section.duplicates.mode": "判定モード",
    "section.duplicates.mode.normalized":
      "正規化 URL（トラッキングパラメータ・末尾スラッシュ・www を無視）",
    "section.duplicates.mode.exact": "完全一致 URL",
    "section.duplicates.run": "重複を検出",
    "section.duplicates.send": "残りを 3 へ送る",
    "section.duplicates.hint":
      "グループごとに「残す 1 件」を選び、残りを 3 へ送ってまとめておくフォルダーへ移動します。この操作は移動だけで、ここでは削除しません。そのフォルダー（例: 「重複（要確認）」）はご自身でブラウザーのブックマークマネージャーから作り、ツリーを再読み込みしてから 3 の「移動先」で選んでください。",
    "section.agent.title": "7. AI エージェントへの引き渡し（任意）",
    "section.agent.note":
      "任意です。1-5 はエージェントなしで使えます。移動の計画をエージェントに任せたい場合は、下のコンテキストファイルとプロンプトを渡してください。どちらも読み込んだツリーから生成します。",
    "section.agent.export": "エージェント向けコンテキストを書き出す (JSON)",
    "section.agent.scope": "配置対象",
    "section.agent.scope.all": "プロファイル全体",
    "section.agent.copyHint":
      "下のテキストを選択してご自身でコピーしてください。この拡張機能はクリップボードを操作しません。",
    "agent.stats":
      "ブックマーク {bookmarks} 件 / フォルダー {folders} 件 / 境界グループ {boundaries} 個",
    "agent.scope.summary":
      "{scope} に限定: 全 {total} 件のうち {bookmarks} 件をエージェントに渡します。",
    "agent.scope.changed":
      "書き出し後に配置対象が変わりました。このプロンプトと合うようにコンテキストを再度書き出してください。",
    "agent.ambiguous.none": "フォルダーパスはすべて一意です。",
    "agent.ambiguous.some":
      "一意でないフォルダーパスが {count} 件あります。それらを移動先にする場合は destinationFolderId が必須です。",
    "agent.export.done":
      "エージェント向けコンテキストを書き出しました: {filename}（{bytes}, sha256={digest}）。",
    "section.plan.title": "3. 適用する移動",
    "section.plan.note":
      "自分で選んでも、エージェントの計画ファイルを読み込んでも構いません。どちらも同じ Dry Run がライブツリーと照合します。",
    "section.plan.manual": "自分で選ぶ",
    "section.plan.source": "探す場所",
    "section.plan.filter": "タイトル・URL で絞り込み",
    "section.plan.destination": "移動先",
    "section.plan.destination.none": "フォルダーを選ぶ",
    "section.plan.build": "この選択を使う",
    "section.plan.clear": "選択を解除",
    "section.plan.fromFile": "エージェントの計画を読み込む",
    "section.plan.file": "エージェント計画ファイル (JSON)",
    "section.plan.run": "Validate / Dry Run",

    "builder.reason": "手動で選択",
    "builder.selected.title": "選択中",
    "builder.candidates.title": "その他",
    "builder.candidates.none":
      "現在の場所と絞り込みに一致する項目はありません。",
    "builder.truncated":
      "先頭 {shown} 件を表示しています（全 {total} 件）。場所か絞り込みを狭めてください。",
    "builder.status.none":
      "移動したいブックマークやフォルダーにチェックを入れてください。",
    "builder.status.selected": "{count} 件を選択中です。",
    "builder.status.selectedNeedsDestination":
      "{count} 件を選択中です。移動先のフォルダーを選んでください。",
    "builder.status.stale":
      "選択の一部がツリーに存在しません。解除して選び直してください。",
    "builder.status.needsDestination": "移動先のフォルダーを選んでください。",
    "builder.status.built":
      "{count} 件の移動を用意しました。下の Dry Run で照合済みです。",
    "builder.status.builtDropped":
      "{count} 件の移動を用意しました。{dropped} 件は選択済みフォルダーごと移動するため除外しました。",
    "section.apply.title": "4. 適用",
    "section.apply.note":
      "Dry Run でブロックされなかった操作だけを 1 件ずつ適用し、外部の変更を検知した時点で即座に中止します。",
    "section.apply.backup": "手順 1 で書き出したスナップショットを再選択",
    "section.apply.button.apply": "承認済みの移動を適用",
    "section.apply.button.verify": "結果を検証",
    "section.apply.button.rollback": "直前のバッチを元に戻す",
    "section.restore.title": "5. スナップショットから復元",
    "section.restore.note":
      "拡張機能を再インストールした後でも使えます。入力はスナップショットファイルだけで、各ノードを個別に照合してから移動します。照合にはタイトルも含むため、スナップショット後に改名されたブックマークは対象外としてスキップされます。",
    "section.restore.file": "スナップショットファイル (JSON)",
    "section.restore.run": "位置を復元",
    "section.trash.title": "6. Trash",
    "section.trash.note":
      "Trash へ送ると、選んだフォルダーへ移動します。この移動では削除しません。項目がそこに残っている間は、バッチ単位で元の並び順のまま戻せます。永続削除は下にある確認付きの別ステップで、元に戻せません。",
    "section.trash.folder": "Trash フォルダー",
    "section.trash.use": "使うフォルダー",
    "section.trash.none": "フォルダーを選んでください",
    "section.trash.createIn": "またはここに作る",
    "section.trash.name": "名前",
    "section.trash.create": "作成する",
    "section.trash.actions": "送る・戻す",
    "section.trash.send": "ステップ 3 の選択を Trash へ送る",
    "section.trash.restore": "直前のバッチを戻す",
    "section.trash.forget": "復元情報を破棄する",
    "section.trash.empty": "完全に削除する",
    "section.trash.emptyNote":
      "この操作は取り消せません。この拡張機能が Trash へ入れた項目だけを 1 件ずつ削除し、記録と一致しない項目があった時点で中止します。ステップ 1 の検証済みバックアップが必須です。",
    "section.trash.emptyConfirm":
      "これらのブックマークが消えることを理解しました",
    "section.trash.emptyRun": "Trash の項目を完全に削除する",
    "trash.status.deleted":
      "{count} を完全に削除しました。この拡張機能からは戻せません。",
    "trash.status.created": "{title} を作成し、Trash フォルダーにしました。",
    "trash.status.sent": "{count} を Trash フォルダーへ送りました。",
    "trash.status.restored": "{count} を送ったときの順番で戻しました。",
    "trash.status.forgotten":
      "{count} 件の復元情報を破棄しました。ブックマークは Trash フォルダーに残っており、失われたのは「どこから来たか」の記録だけです。",
    "trash.status.working": "実行中: {total} 件中 {done} 件。",
    "trash.status.failed": "Trash の操作に失敗しました: {message}",
    "trash.status.empty": "復元情報はまだありません。",
    "trash.status.unreadable":
      "保存されている Trash の記録を読み取れませんでした（{reason}）。記録はそのまま残してあり、新しいバージョンの記録を上書きしないよう送信と復元を無効にしています。",
    "trash.status.quarantined":
      "破損した記録を {count} 件隔離しました。それらが指すブックマークは、破棄するまで戻せません。",
    "trash.panel.title": "復元情報",
    "trash.column.item": "ブックマーク",
    "trash.column.state": "状態",
    "trash.column.origin": "元の場所",
    "trash.column.batch": "バッチ",
    "trash.column.retention": "保持期間",
    "trash.state.pending": "未確定",
    "trash.state.trashed": "Trash にあり",
    "trash.state.restoring": "戻し中",
    "trash.state.restored": "戻し済み",
    "trash.state.deleting": "削除中",
    "trash.state.deleted": "削除済み",
    "trash.state.orphaned": "見つからない",
    "trash.state.failed": "要確認",
    "trash.retention.active": "{date} までの目安",
    "trash.retention.expired": "目安は経過。項目があれば戻せます",

    "apply.backup.checking": "スナップショットを検証中...",
    "apply.backup.ok":
      "バックアップを検証しました: {filename}（sha256={digest}）。適用を解錠しました。",
    "apply.backup.digestMismatch":
      "このツリー向けに書き出したスナップショットではありません。",
    "apply.backup.treeMismatch":
      "別のツリー状態で取ったスナップショットです。取り直してください。",
    "apply.backup.failed": "スナップショットを検証できませんでした: {message}",
    "apply.resume.notApplied": "移動は実行されておらず、そのままにしました",
    "apply.resume.conflict": "ノードが元の位置にも適用先の位置にもありません",
    "apply.status.approved":
      "{count} 件を承認しました。バックアップを検証すると適用できます。",
    "apply.status.pending":
      "前回のバッチが未完了です。{count} 件の移動を検証またはロールバックできます。",
    "apply.status.running": "適用中 {done} / {total}...",
    "apply.status.done": "{count} 件を適用しました。",
    "apply.status.aborted": "バッチを中止しました: {message}",
    "apply.status.rollingBack": "元に戻しています {done} / {total}...",
    "apply.status.rolledBack": "{count} 件を元に戻しました。",
    "apply.status.verified":
      "検証完了: {total} 件中 {ok} 件が適用した位置のままです。",
    "apply.status.verifyFailed":
      "適用した位置にない移動が {count} 件あります。",
    "apply.drift.title": "このバッチ以外で変わった内容",
    "apply.drift.id": "id",
    "apply.drift.field": "項目",
    "apply.drift.expected": "期待値",
    "apply.drift.actual": "実際の値",
    "apply.drift.truncated":
      "先頭 {shown} 件のみ表示しています（全 {total} 件）。",
    "apply.col.opId": "opId",
    "apply.col.status": "状態",
    "apply.col.expected": "期待位置",
    "apply.col.actual": "実際の位置",
    "verify.verified": "適用した位置のまま",
    "verify.position-mismatch": "その後移動済み",
    "verify.title-mismatch": "その後改名済み",
    "verify.missing": "消失",
    "verify.not-applied": "未適用",

    "restore.status.checking": "スナップショットを検証中...",
    "restore.status.rejected":
      "このプロファイルのスナップショットではありません（全 {total} ノード中 {matched} 件しか一致）。",
    "restore.status.ready":
      "{moves} 件を元の位置へ戻します。{skipped} 件はスキップします。",
    "restore.status.nothing":
      "すべてのノードがスナップショットの位置にあります。",
    "restore.status.running": "復元中 {done} / {total}...",
    "restore.status.done": "{count} 件を復元しました。",
    "restore.status.failed": "復元を中止しました: {message}",
    "restore.skipped.title": "スキップしたノード",
    "restore.moves.title": "この復元で行う移動",
    "restore.moves.from": "移動元",
    "restore.moves.to": "移動先",
    "restore.skipped.id": "id",
    "restore.skipped.reason": "理由",

    "tree.status.loading": "読み込み中...",
    "tree.status.loaded": "読み込み完了: {count} ノード",
    "tree.status.failed": "読み込み失敗: {message}",
    "tree.stat.item": "項目",
    "tree.stat.value": "値",
    "tree.stat.urls": "URL 数",
    "tree.stat.folders": "フォルダ数",
    "tree.stat.depth": "最大深さ",
    "tree.stat.digest": "treeDigest (SHA-256)",
    "tree.stat.browser": "ブラウザー",
    "tree.stat.boundary": "境界シグナル (syncing)",
    "tree.boundary.available": "利用可能",
    "tree.boundary.missing": "未提供 — 適用は実行できません",
    "tree.roots.title": "恒久ルート",
    "tree.roots.id": "id",
    "tree.roots.title.column": "title",
    "tree.roots.folderType": "folderType",
    "tree.roots.syncing": "syncing",
    "tree.roots.children": "直下の件数",
    "tree.roots.subtree": "配下のブックマーク数",
    "tree.export.done":
      "スナップショットを書き出しました: {filename}（{bytes}, sha256={digest}）。ファイルがディスクに届いたかはページから確認できないため、適用する前に 4 でこのファイルを選び直してください。",

    "duplicates.summary": "{mode}モード: {groups} グループ / 重複 {count} 件",
    "duplicates.mode.normalized": "正規化",
    "duplicates.mode.exact": "完全一致",
    "duplicates.unparsable":
      "URL として解析できなかった項目: {count} 件（判定対象外）",
    "duplicates.col.id": "id",
    "duplicates.col.path": "path",
    "duplicates.keep.legend": "{key} のうち 1 件を残す",
    "duplicates.groups.truncated":
      "先頭 {shown} グループを表示しています（全 {total} グループ）。",
    "duplicates.groups.showAll": "全 {total} グループを表示",
    "duplicates.group.truncated":
      "先頭 {shown} 件を表示しています（全 {total} 件）。全件を表示するまでこのグループは送れません。",
    "duplicates.group.showAll": "全 {total} 件を表示",
    "duplicates.status.summaryPick":
      "{mode}モード: {groups} グループ / 重複 {count} 件。グループごとに残す 1 件を選び、3 で移動先を選んでください。",
    "duplicates.status.summaryDestination":
      "{mode}モード: {groups} グループ / 重複 {count} 件。3 の「移動先」でまとめておくフォルダーを選んでください。",
    "duplicates.none":
      "現在の判定モードでは、このプロファイルに重複はありません。",
    "duplicates.status.sent": "3 の選択に {count} 件追加しました。",
    "duplicates.status.sentNone":
      "追加された項目はありません。レポート先頭の理由を確認してください。",
    "duplicates.sent.title": "前回の送信",
    "duplicates.sent.added": "3 の選択に追加: {count} 件",
    "duplicates.skip.no-keeper": "残す 1 件が未選択: {count} 件",
    "duplicates.skip.stale-keeper":
      "残すと選んだ項目がツリーにありません: {count} 件",
    "duplicates.skip.truncated":
      "グループ内の全件がまだ表示されていません: {count} 件",
    "duplicates.skip.already-there":
      "既に移動先フォルダーの直下にあります: {count} 件",
    "duplicates.skip.boundary":
      "アカウント / ローカルの境界をまたぐか、境界を確定できません: {count} 件",
    "duplicates.skip.limit":
      "1 バッチ上限 {limit} 件を超えます。このバッチを適用し、ツリーを再読み込みしてから続きを送ってください: {count} 件",

    "plan.status.loaded":
      "計画を読み込みました: {count} 操作 / planDigest={digest}",
    "plan.status.loading": "計画ファイルを読み込み中...",
    "plan.status.invalid": "スキーマ検証に失敗: {count} 件",
    "plan.status.tooLarge":
      "この計画は {count} 操作で、1 バッチの上限 {limit} を超えています。分割して順に実行してください。",
    "plan.status.failed": "読み込み失敗: {message}",
    "plan.error.path": "path",
    "plan.error.message": "message",
    "plan.errors.truncated":
      "先頭 {shown} 件のみ表示しています（全 {total} 件）。",
    "dryRun.col.opId": "opId",
    "dryRun.col.kind": "操作",
    "dryRun.col.status": "status",
    "dryRun.col.current": "現在 path",
    "dryRun.col.destination": "移動先 path / 新しいタイトル",
    "dryRun.kind.move": "移動",
    "dryRun.kind.rename": "改名",
    "dryRun.rename.to": "「{title}」へ改名",
    "dryRun.col.detail": "detail",
    "dryRun.col.reason": "reason",
    "dryRun.col.confidence": "confidence",
    "dryRun.summary.category": "分類",
    "dryRun.notes": "エージェントのメモ: {notes}",
    "dryRun.truncated":
      "先頭 {shown} 件のみ表示しています（全 {total} 件）。上の件数は全操作を含みます。",
    "dryRun.summary.count": "件数",
    "dryRun.totals":
      "適用可能 {movable} 件 / ブロック {blocked} 件（適用可能な操作だけを適用します）",
    "dryRun.status.clean":
      "Dry Run 完了: ブロックなし（適用可能 {movable} 件）",
    "dryRun.status.blocked": "Dry Run 完了: {count} 件が適用不可",

    "status.movable": "適用可能",
    "status.no-op": "変更不要",
    "status.duplicate-op": "操作の重複",
    "status.unsupported-op-type": "未対応の操作種別",
    "status.id-not-found": "ID 未検出",
    "status.permanent-root-source": "恒久ルート",
    "status.unmodifiable-node": "変更不可ノード",
    "status.title-mismatch": "title 不一致",
    "status.url-mismatch": "url 不一致",
    "status.current-path-mismatch": "現在 path 不一致",
    "status.rename-not-a-bookmark": "フォルダーは改名不可",
    "status.rename-unchanged": "タイトルが同一",
    "status.rename-too-long": "新しいタイトルが長すぎ",
    "status.rename-trash-managed": "Trash 台帳の管理下",
    "status.destination-not-found": "移動先が見つからない",
    "status.destination-ambiguous": "移動先が曖昧",
    "status.destination-id-not-found": "移動先 ID 未検出",
    "status.destination-not-folder": "移動先がフォルダでない",
    "status.destination-conflict": "移動先の指定が矛盾",
    "status.destination-unmodifiable": "移動先が変更不可",
    "status.destination-is-descendant": "移動先が自身の子孫",
    "status.boundary-violation": "境界違反",
    "status.boundary-indeterminate": "境界が判定不能",
    "status.operation-interdependent": "操作どうしが干渉",

    "detail.movable": "事前条件を満たしています",
    "detail.noOp": "すでに移動先フォルダにあります",
    "detail.duplicateOp": "同じ bookmarkId が複数の操作に現れています",
    "detail.unsupportedType": '未対応の操作種別 "{type}"',
    "detail.permanentRootSource": "恒久ルートフォルダは移動できません",
    "detail.unmodifiableNode": "ノードが変更不可です（{reason}）",
    "detail.idNotFound": "bookmarkId がライブツリーに存在しません",
    "detail.titleMismatch": '実際の title は "{liveTitle}" です',
    "detail.urlMismatch": "実際の url は {liveUrl} です",
    "detail.urlMismatchFolder":
      "実際のノードはブックマークではなくフォルダです",
    "detail.currentPathMismatch": "計画の生成後にブックマークが移動しています",
    "detail.renameNotABookmark":
      "このバージョンで改名できるのはブックマークだけです。フォルダー名は配下すべてのノードの path の一部になります",
    "detail.renameUnchanged": "newTitle が現在のタイトルと同じです",
    "detail.renameTooLong":
      "newTitle が {count} 文字で、上限 {limit} 文字を超えています",
    "detail.renameTrashManaged":
      "Trash 台帳にこのブックマークの記録が残っており、タイトルはその照合対象です",
    "detail.destinationNotFound":
      "destinationPath がどのフォルダにも解決しません",
    "detail.destinationAmbiguous":
      "destinationPath が {count} 個のフォルダに解決します",
    "detail.destinationIdNotFound":
      "destinationFolderId がライブツリーに存在しません",
    "detail.destinationNotFolder":
      "destinationFolderId がフォルダではありません",
    "detail.destinationConflict":
      "destinationFolderId と destinationPath が別のフォルダを指しています",
    "detail.destinationUnmodifiable": "移動先が変更不可です（{reason}）",
    "detail.destinationIsDescendant": "移動先がそのフォルダ自身または子孫です",
    "detail.boundaryIndeterminate":
      "この実行環境では account / local 境界を証明できません",
    "detail.boundaryViolation":
      "account / local 境界を越えます（{from} -> {to}）",
    "detail.operationInterdependent":
      "この計画内の別の操作が、このノード・移動先・着地するフォルダのいずれかを動かします",

    "schema.notObject": "計画は JSON オブジェクトである必要があります",
    "schema.version": "version は {expected} である必要があります",
    "schema.generatedAt": "generatedAt は文字列である必要があります",
    "schema.generatedBy": "generatedBy は文字列である必要があります",
    "schema.notes": "notes は文字列である必要があります",
    "schema.unknownField":
      '未知のフィールド "{field}" です。計画スキーマは追加プロパティを許可しません',
    "schema.operations": "operations は配列である必要があります",
    "schema.tooManyOperations":
      "operations が {count} 件で、計画 1 つあたりの上限 {limit} 件を超えています",
    "schema.operationNotObject": "操作はオブジェクトである必要があります",
    "schema.opId": "opId は空でない文字列である必要があります",
    "schema.opIdDuplicate": 'opId が重複しています "{opId}"',
    "schema.type":
      'type は "move"、バージョン 2 の計画では "update" も指定できます',
    "schema.bookmarkId": "bookmarkId は空でない文字列である必要があります",
    "schema.expectedTitle": "expectedTitle は文字列である必要があります",
    "schema.expectedUrl":
      "expectedUrl は文字列または null である必要があります",
    "schema.currentPath": "currentPath は文字列の配列である必要があります",
    "schema.newTitle":
      "newTitle は空でない {limit} 文字以内の文字列である必要があります",
    "schema.destinationPath":
      "destinationPath は空でない文字列の配列である必要があります",
    "schema.destinationFolderId":
      "destinationFolderId は文字列である必要があります",
    "schema.reason": "reason は空でない文字列である必要があります",
    "schema.confidence":
      "confidence は 0 以上 1 以下の数値である必要があります",

    "apply.reject.noApproval": "承認済みの Dry Run がありません",
    "apply.reject.planChanged": "承認後に計画ファイルが変わっています",
    "apply.reject.treeChanged":
      "Dry Run の承認後にブックマークツリーが変わっています",
    "apply.reject.noBackup": "バックアップが検証されていません",
    "apply.reject.opNoLongerMovable":
      "操作 {opId} は現在のツリーに対して適用できません",
    "apply.reject.noJournal": "バッチのジャーナルがありません",
    "apply.reject.journalPlanMismatch": "ジャーナルが別の計画のものです",
    "apply.reject.journalBackupMismatch":
      "ジャーナルが別のバックアップのものです",
    "apply.reject.journalUnusable":
      "保存済みのバッチ記録を読めなかったため（{reason}）、再生せずに無視しました。記録は削除していません。スナップショットからの復元で移動は戻せますが、照合にタイトルを使うため改名は戻せません。",
    "apply.reject.batchPending":
      "元に戻せるバッチが残っています。ロールバックか検証を済ませてから次を適用してください。",
    "apply.quarantine.landed":
      "コピーを {path} へ移動しました。この操作では削除しません。中身を確認したり消したりする場合は、ブラウザーのブックマーク マネージャーを開いてください。",

    "apply.abort.externalChange":
      "このバッチ以外がブックマークを変更しました（{kind}）",
    "apply.abort.foreignMove":
      "このバッチが依頼していない移動が通知されました（{id}）",
    "apply.abort.treeDrift": "ツリーがこのバッチの予期した状態と一致しません",
    "apply.abort.preconditionLost": "操作の前提条件が失われました（{status}）",
    "apply.abort.movedNodeGone": "バッチ中にノードが消えました",
    "apply.abort.foreignRemoval":
      "バッチ実行中に他の何かが {id} を削除しました",
    "delete.abort.noSnapshot":
      "削除には検証済みのバックアップが必要ですが、確認されていません",
    "delete.abort.notTrashed": "{id} は Trash 送りの記録ではありません",
    "delete.abort.gone": "{id} はツリーに存在しません",
    "delete.abort.notBookmark": "{id} は削除できるブックマークではありません",
    "delete.abort.identityMismatch":
      "{id} が記録と一致しなくなっているため、削除しませんでした",
    "delete.abort.leftTrash":
      "{id} は Trash フォルダーにないため、削除しませんでした",
    "delete.abort.boundary":
      "その項目の account / local ストアを確認できませんでした",
    "delete.abort.stillPresent":
      "削除後もブラウザーが {id} を報告するため、バッチを中止しました",
    "trash.abort.nodeGone": "{id} はツリーに存在しません",
    "trash.create.invalidParent":
      "その場所には Trash フォルダーを作成できません",
    "trash.create.boundaryUnknown":
      "このブラウザーがその場所のストアを報告しないため、そこに作った Trash からは項目を戻せません",
    "trash.create.unverified":
      "作成を依頼した場所にフォルダーが見つからなかったため、Trash フォルダーとして採用しませんでした。id {id} のフォルダーが残っている可能性があります。拡張機能はこれを自動で消さないので、不要なら手動で削除してください。",
    "trash.abort.notBookmark":
      "{id} は移動できるブックマークではありません。このバージョンはブックマークのみを扱います",
    "trash.abort.destinationInvalid":
      "指定された Trash フォルダーには移動できません",
    "trash.abort.alreadyInTrash": "{id} はすでに Trash フォルダーにあります",
    "trash.abort.boundary":
      "Trash フォルダーが account / local 境界の反対側にあります",
    "trash.abort.capacity":
      "Trash の記録が上限です（{verdict}）。先に復元するか、記録を破棄してください。破棄すると復元情報だけが失われ、ブックマークはそのまま残ります。",
    "restore.abort.notExact":
      "このバッチはもうまとめて元へ戻せません（{verdict}）",
    "restore.abort.preconditionLost":
      "この項目は復元できなくなりました（{verdict}）",
    "restore.abort.receiptGone": "{id} の記録が見つかりません",
    "apply.abort.boundaryLost":
      "この移動で account / local 境界が成立しなくなりました",
    "apply.abort.landedElsewhere":
      "ブラウザーがノードを index {index} に配置しました",
    "apply.abort.rollbackConflict": "{opId} を元の位置へ正確に戻せませんでした",
    "apply.abort.movedSinceApply":
      "{opId} はこのバッチが置いた位置にないため、戻しませんでした",
    "apply.abort.changedSinceApply":
      "{opId} はこのバッチが書いたタイトルではないため、戻しませんでした",
    "apply.abort.titleNotWritten":
      "改名後にブラウザーがタイトルを「{title}」と報告しました",
    "apply.abort.restoreUnauthorised":
      "{id} がプレビュー後にスナップショットと一致しなくなりました",
    "apply.abort.failed": "バッチが失敗しました: {message}",

    "agent.error.unknownCommand": "その command はこの API にありません",
    "agent.error.inputNotObject": "{command} の引数はオブジェクトか省略です",
    "agent.error.unknownField": '{command} は "{field}" を受け付けません',
    "agent.error.query": "search には空でない query が必要です",
    "agent.error.limit": "{command} の limit は 1〜{limit} です",
    "agent.error.planNotObject": "loadPlan には計画文書自体を渡します",
    "agent.error.tooManyOperations":
      "計画の操作が {count} 件で、上限 {limit} 件を超えています",
    "agent.error.noTree": "先にツリーを読み込んでください",
    "agent.error.notReady":
      '現在は実行できません。"{control}" が無効で、API はそれを迲回しません',
    "agent.error.failed": "command が失敗しました: {message}",
    "agent.error.busy": "別の command が実行中です。この API は逐次実行です",

    "snapshot.kind": 'kind は "{expected}" である必要があります',
    "snapshot.version": "version は {expected} である必要があります",
    "snapshot.treeDigest": "treeDigest は空でない文字列である必要があります",
    "snapshot.nodes": "nodes は配列である必要があります",
    "snapshot.tooManyNodes":
      "nodes が {count} 件で、スナップショット 1 つの上限 {limit} を超えています",
    "snapshot.nodeNotObject": "各 node はオブジェクトである必要があります",
    "snapshot.nodeId": "id は空でない文字列である必要があります",
    "snapshot.nodeParentId": "parentId は空でない文字列である必要があります",
    "snapshot.nodeIndex": "index は 0 以上の整数である必要があります",
    "snapshot.nodeTitle": "title は文字列である必要があります",
    "snapshot.nodeUrl": "url は文字列または null である必要があります",

    "restore.skip.nodeMissing": "ノードが存在しません",
    "restore.skip.nodeMismatch":
      "実際のノードがスナップショットの記録と一致しません",
    "restore.skip.parentMissing": "属すべきフォルダが存在しません",
    "restore.skip.parentMismatch":
      "属すべきフォルダがスナップショットの記録と一致しません",
    "restore.skip.ancestorMismatch":
      "移動先パス上のフォルダがスナップショットの記録と一致しません",
    "restore.skip.unmodifiable": "ノードが変更不可です",
    "restore.skip.boundary": "戻すと account / local 境界を越えてしまいます",
    "restore.skip.boundary": "戻すと account / local 境界を越えてしまいます",

    "error.bookmarksUnavailable":
      "ブックマーク API を利用できません。インストール済みの拡張機能から開いてください。",
    "error.fileRead": "ファイルを読み取れませんでした（{detail}）。",
    "error.fileTooLarge":
      "計画ファイルが {sizeBytes} で、上限の {limitBytes} を超えています。エクスポート全体ではなく計画ファイルを選んでください。",
    "error.exportFailed": "書き出しに失敗しました: {message}",
    "error.storageUnavailable":
      "拡張機能のストレージを利用できず、バッチのジャーナルを保持できません。",
    "error.trashLedgerConflict":
      "保存中に別のタブが Trash の記録を変更しました。再読み込みしてやり直してください。",
    "error.locksUnavailable":
      "この実行環境には Web Locks API がなく、他タブを排他できません。",
    "error.applyLockBusy":
      "この拡張機能の別タブがバッチを実行中です。先にそちらを完了してください。",
    "browser.edge": "Microsoft Edge",
    "browser.chrome": "Google Chrome",
    "browser.other": "その他の Chromium ブラウザー",
  },
};
