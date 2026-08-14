/** Fixture shaped like chrome.bookmarks.getTree() output on a Chrome 134+ profile. */
export function sampleTree() {
  return [
    {
      id: "0",
      title: "",
      children: [
        {
          id: "1",
          parentId: "0",
          index: 0,
          title: "ブックマーク バー",
          folderType: "bookmarks-bar",
          syncing: true,
          children: [
            {
              id: "10",
              parentId: "1",
              index: 0,
              title: "Dev",
              syncing: true,
              children: [
                {
                  id: "100",
                  parentId: "10",
                  index: 0,
                  title: "Chrome API",
                  url: "https://developer.chrome.com/docs/extensions/reference/api/bookmarks",
                  syncing: true,
                },
                {
                  id: "101",
                  parentId: "10",
                  index: 1,
                  title: "Nested",
                  syncing: true,
                  children: [],
                },
              ],
            },
            {
              id: "11",
              parentId: "1",
              index: 1,
              title: "Shared",
              syncing: true,
              children: [],
            },
            {
              id: "110",
              parentId: "1",
              index: 2,
              title: "Docs",
              url: "https://example.com/a?utm_source=x",
              syncing: true,
            },
          ],
        },
        {
          id: "2",
          parentId: "0",
          index: 1,
          title: "その他のブックマーク",
          folderType: "other",
          syncing: true,
          children: [
            {
              id: "200",
              parentId: "2",
              index: 0,
              title: "Loose",
              url: "https://example.com/a/",
              syncing: true,
            },
            {
              id: "201",
              parentId: "2",
              index: 1,
              title: "Shared",
              syncing: true,
              children: [],
            },
          ],
        },
        {
          id: "3",
          parentId: "0",
          index: 2,
          title: "ローカル ブックマーク バー",
          folderType: "bookmarks-bar",
          syncing: false,
          children: [
            {
              id: "300",
              parentId: "3",
              index: 0,
              title: "Local only",
              syncing: false,
              children: [],
            },
          ],
        },
        {
          id: "4",
          parentId: "0",
          index: 3,
          title: "管理対象",
          folderType: "managed",
          syncing: false,
          unmodifiable: "managed",
          children: [
            {
              id: "400",
              parentId: "4",
              index: 0,
              title: "Policy",
              url: "https://example.org/policy",
              syncing: false,
              unmodifiable: "managed",
            },
          ],
        },
      ],
    },
  ];
}

export function moveOperation(overrides = {}) {
  return {
    opId: "op-1",
    type: "move",
    bookmarkId: "200",
    expectedTitle: "Loose",
    expectedUrl: "https://example.com/a/",
    currentPath: ["その他のブックマーク", "Loose"],
    destinationPath: ["ブックマーク バー", "Dev"],
    reason: "developer resource",
    confidence: 0.9,
    ...overrides,
  };
}

export function planWith(...operations) {
  return { version: 1, generatedAt: "2026-08-13T00:00:00.000Z", operations };
}

/** Same shape the options page writes out, built from flattened entries. */
export function snapshotFrom(entries) {
  return {
    version: 1,
    kind: "bookmark-tree-snapshot",
    exportedAt: "2026-08-13T00:00:00.000Z",
    treeDigest: "digest",
    nodes: entries
      .filter((entry) => !entry.isRoot)
      .map((entry) => ({
        id: entry.id,
        parentId: entry.parentId,
        index: entry.index,
        title: entry.title,
        url: entry.url,
        dateAdded: entry.dateAdded,
        syncing: entry.syncing,
        folderType: entry.folderType,
        unmodifiable: entry.unmodifiable,
        path: entry.path,
      })),
  };
}
