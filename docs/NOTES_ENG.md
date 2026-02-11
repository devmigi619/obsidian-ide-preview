# IDE Preview Plugin — API Reference

Documents Obsidian internal APIs and key discoveries.

---

## Obsidian Internal API

### WorkspaceLeaf (Tab)
- `openFile(file, openState)`: Open a file
- `setViewState(viewState, eState)`: Change view state (including non-file views)
- `detach()`: Close the tab
- `getViewState()`: Get current view state
- `view`: Current view object

### Workspace
- `getActiveLeaf()`: Get currently active tab
- `getLeavesOfType(type)`: Get list of tabs by type
- `leftSplit`, `rightSplit`: Left/right sidebars
- `on('file-open', callback)`: File opened event

---

## Sidebar View DOM Structure Differences

### File Explorer (file-explorer)
- **Internal state**: Uses `view.activeDom`
- **DOM attributes**: Has `data-path` attribute
- **Selection classes**: `is-active`, `has-focus`
- **Key properties**: `activeDom`, `fileItems`, `tree`
- **Key method**: `onFileOpen(file)` — syncs selection state

### Bookmarks
- **Internal state**: Does NOT use `view.activeDom`
- **DOM attributes**: **No** `data-path` attribute
- **Selection classes**: `is-active`, `has-focus` (same)
- **Key properties**: `itemDoms`, `tree`
- **Note**: Uses `.tree-item-self.bookmark` class

### Search
- **Internal state**: No `view.activeDom`
- **Key properties**: `dom`

### Other Views (outline, tag, backlink, outgoing-link)
- **Internal state**: No DOM-related keys

---

## Sidebar View Internal Structure

### Common Pattern: tree Object

Both file explorer and bookmarks manage selection state through the `view.tree` object.

```typescript
view.tree: {
  activeDom: object | null,     // Currently active (selected) item
  focusedItem: object | null,   // Focused item
  selectedDoms: Set,            // Multi-selection (Set type)
  prefersCollapsed: boolean,
  isAllCollapsed: boolean,
  ...
}
```

### File Explorer (file-explorer)

**Instance Properties:**
- `activeDom`: Currently selected item (**Note: separate object from tree.activeDom!**)
- `fileItems`: Map of all file/folder items (path → DOM info)
- `tree`: Tree state management object

**activeDom Structure:**
```typescript
activeDom: {
  el: HTMLElement,        // Full item element
  selfEl: HTMLElement,    // Selection-highlighted element (.tree-item-self)
  innerEl: HTMLElement,
  file: TFile,            // File object (access path via file.path)
  ...
}
```

**fileItems Entry Structure:**
```typescript
fileItems[path]: {
  el, selfEl, innerEl, file,
  collapsible, collapsed, collapseEl, childrenEl, ...
}
```

**Key Methods:**
- `onFileOpen(file)`: Sync selection state on file open
- `revealActiveFile()`: Reveal active file
- `revealInFolder(file)`: Reveal specific file

### Bookmarks

**Instance Properties:**
- `tree`: Tree state management object (same structure as file explorer)
- `itemDoms`: Bookmark item DOM map

**Key Methods:**
- `getItemDom(item)`: Get item's DOM

---

## Key Discovery: explorerView.activeDom vs tree.activeDom

### Two activeDom Objects Exist!

```javascript
explorerView.activeDom: null (or object)
tree.activeDom: object (or null)
Same object?: false
```

| Property | Level | Role |
|----------|-------|------|
| `explorerView.activeDom` | View level | Used by Obsidian to determine is-active class application |
| `tree.activeDom` | Tree widget level | Manages internal tree selection state |

**Important**: These are separate objects; the `onFileOpen` method syncs them.

### onFileOpen Method Behavior

```javascript
// explorerView.onFileOpen behavior (simplified)
function onFileOpen(file) {
  var newItem = file ? this.fileItems[file.path] : null;

  if (newItem !== this.activeDom) {
    // Remove is-active from old activeDom
    this.activeDom?.selfEl.removeClass("is-active");

    // Set new activeDom and add is-active
    this.activeDom = newItem;
    this.tree.activeDom = newItem;
    newItem?.selfEl.addClass("is-active");
  }
}
```

**Key Points:**
- `onFileOpen(file)` syncs `activeDom` and `tree.activeDom`
- However, due to the `newItem !== this.activeDom` condition, **it does nothing if the state is already the same**
  - Example: when `activeDom` is already `null`, calling `onFileOpen(null)` → tree.activeDom unchanged
- Observed: `tree.activeDom` may remain after `onFileOpen(null)`
  - Fix: explicitly set `tree.activeDom = null` after `onFileOpen(null)` in our code

---

## tree Prototype Methods

### Key Methods

| Method | Role |
|--------|------|
| `setFocusedItem(item, scroll)` | Set focus (manages has-focus) |
| `clearSelectedDoms()` | Clear multi-selection (is-selected) |
| `selectItem(item)` | Add to multi-selection (is-selected) |
| `deselectItem(item)` | Remove from multi-selection (is-selected) |
| `handleItemSelection(event, item)` | Item selection handler |

### setFocusedItem Source Code

```javascript
function setFocusedItem(item, scrollIntoView = true) {
  if (item !== this.root) {
    // Remove has-focus from old focused item
    if (this.isItem(this.focusedItem)) {
      this.focusedItem.selfEl.removeClass("has-focus");
    }

    this.focusedItem = item;

    // Add has-focus to new item
    if (item && this.isItem(item)) {
      item.selfEl.addClass("has-focus");
      if (scrollIntoView) {
        this.infinityScroll.scrollIntoView(item);
      }
    }
  }
}
```

### CSS Class Roles

| Class | Purpose | Managed By |
|-------|---------|------------|
| `is-active` | Single active item (gray background) | `onFileOpen` |
| `has-focus` | Keyboard focus (dark gray border) | `setFocusedItem` |
| `is-selected` | Multi-selection | `selectItem`/`deselectItem` |

---

## Core Principle

**"Use official methods first; manually fix when necessary."**

| Task | Primary Method | Fallback (when needed) |
|------|----------------|----------------------|
| Deselect | `explorerView.onFileOpen(null)` | `tree.activeDom = null` (when onFileOpen skips) |
| Unfocus | `tree.setFocusedItem(null)` | - |
| Clear multi-select | `tree.clearSelectedDoms()` | - |
| Clean DOM classes | Use official methods | Remove directly when internal state is null but DOM remains |

**Principles**:
- Use official methods first to maintain internal state consistency
- `onFileOpen(null)` may not always reset `tree.activeDom`, so manually fix when needed
- "Don't try to fix the cause — verify the result and correct it" strategy is effective with Obsidian API

---

## Important Notes

### setPinned Patch

**Role**: Auto-promote Preview → Permanent when pinning a tab

```typescript
// patchSetPinned: pinning a tab promotes Preview to Permanent
if (pinned && plugin.previewLeaves.has(this)) {
  plugin.promoteToPermanent(this);
}
```

- Pinning a Preview tab automatically converts it to Permanent
- Unpinning has no effect (stays Permanent)

### openState.eState Mutation Issue

**Symptom**: `openState.eState` mutates after `originalMethod.call()`

**Solution**: Save needed values **before** the call
```typescript
// Save before originalMethod since openState may mutate
const shouldApplyRename = openState?.eState?.rename === "all";
const result = await originalMethod.call(newLeaf, file, openState);
// Use saved value for decision
if (shouldApplyRename) { ... }
```

### Bookmarks Lack data-path Attribute

**Symptom**: Bookmarks don't have a `data-path` attribute, so `[data-path]` selectors can't find them

**Solution**: Select `.is-active`, `.has-focus` directly within sidebar areas instead of relying on `data-path`
```typescript
const sidebars = document.querySelectorAll('.workspace-split.mod-left-split, .workspace-split.mod-right-split');
sidebars.forEach(sidebar => {
  const activeItems = sidebar.querySelectorAll('.tree-item-self.is-active, .tree-item-self.has-focus');
  activeItems.forEach(item => {
    item.classList.remove('is-active', 'has-focus');
  });
});
```

### Link Testing Impossible from Empty Tab

**Symptom**: Wiki-links, Backlinks, Outgoing Links cannot be tested from an Empty tab

**Reason**: A note must already be open to click links
- **Wiki-links**: Exist within note body
- **Backlinks/Outgoing Links**: Sidebar panels only appear when a file is open

**Testable states**: Permanent tab, Preview tab only

### Recent Files Requires a Plugin

**Symptom**: "Recent Files" is not a built-in Obsidian feature

**Details**:
- **Random Note**: Core plugin, built-in
- **Recent Files**: Requires separate plugin
  - [Recent Files Plugin](https://github.com/tgrosinger/recent-files-obsidian)
  - Quick Switcher shows recent files, but there's no dedicated UI/command

**Test scope**: Random Note only; Recent Files excluded

### Canvas Handling

#### Canvas Creation vs Opening

**Canvas Creation** (ribbon button):
- `vault.create()` call → hooked by `patchVaultCreate()`
- Added to `newlyCreatedFiles` Set
- `handleOpenFile()` forces `openState.eState.rename = "all"`
- `determineOpenIntent()` → returns "create"
- **Result**: Create pattern → Permanent tab (title edit mode)

**Canvas Opening** (file explorer single click):
- Opening existing Canvas file
- No `rename` flag
- `determineOpenIntent()` → Canvas extension check → returns "browse"
- **Result**: Browse pattern → Preview tab

#### Canvas Permanent Promotion

**1. Canvas Editing (auto-promotion)**:
- Adding/editing/deleting nodes
- Adding/editing/deleting edges
- Dragging nodes
- Opening node editor (double-click)
- **Detection**: `vault.modify` event
- **Note**: Viewport panning (Space+drag), zooming (Ctrl+scroll) need testing
  - Canvas files (.canvas) are JSON and may store viewport info

**2. File Rename (auto-promotion)**:
- Only promotes Canvas files currently open in a Preview tab
- **Detection**: `vault.rename` event + check if file is in a Preview tab

**3. Double-click (manual promotion)**:
- Tab header double-click
- File explorer / bookmarks / search result double-click

#### determineOpenIntent Logic

```typescript
// 1. rename: "all" → create (includes Canvas creation)
if (openState?.eState?.rename === "all") {
  return "create";
}

// 2. Canvas/PDF extension check → browse
if (file.extension === "canvas" || file.extension === "pdf") {
  return "browse";
}

// 3. Daily Notes pattern → create
// 4. Default → browse
```

This ordering correctly distinguishes Canvas creation from opening.

### Double-Click Promotion Mechanism

#### Core Concept: lastActiveLeaf Tracking

**Problem**: By the time a double-click fires, the single-click has already opened the file. How do we distinguish double-click intent?

**Solution**: Track the "most recently active file" via the `lastActiveLeaf` state variable

```typescript
// file-open event handler in registerFileOpenHandler()
const viewType = activeLeaf?.view?.getViewType();
if (viewType === "markdown" || viewType === "canvas" || viewType === "pdf") {
  this.lastActiveLeaf = activeLeaf;  // Track MD, Canvas, PDF
}
```

#### Double-Click Scenarios

| Scenario | Method | Action | Uses lastActiveLeaf? |
|----------|--------|--------|---------------------|
| **1. Tab header dblclick** | `handleDoubleClick` | Promote active tab | No (uses activeLeaf directly) |
| **2. Sidebar dblclick** | `handleDoubleClick` | Promote lastActiveLeaf | Yes |
| **3. Graph view dblclick** | `handleDoubleClick` | Promote lastActiveLeaf | Yes |
| **4. Ribbon button dblclick** | `handleRibbonDoubleClick` | Promote active tab or set flag | Mixed |

#### Timing Flow

```
T1: User starts double-click
T2: Single-click handler → file opens (Preview)
T3: file-open event → lastActiveLeaf updated (MD/Canvas/PDF)
T4: Double-click handler → check lastActiveLeaf → promote
```

#### PDF Double-Click Promotion

**Problem (before fix)**:
1. PDF was not tracked in `lastActiveLeaf`
2. Sidebar double-click uses lastActiveLeaf → PDF couldn't be promoted
3. Only tab header double-click worked (uses activeLeaf directly)

**Solution (after fix)**:
- PDF included in `lastActiveLeaf` tracking (`registerFileOpenHandler()` viewType check)
- All double-click scenarios now work for PDF promotion

#### Key Code Locations

- `lastActiveLeaf` declaration: class state field
- Update trigger: `registerFileOpenHandler()` → `file-open` event
- MD/Canvas/PDF filter: viewType check in `file-open` handler
- Double-click handler: `handleDoubleClick()`
- Sidebar handling: sidebarContent branch in `handleDoubleClick()` (uses lastActiveLeaf)
- Tab header handling: workspace-tab-header branch in `handleDoubleClick()` (uses activeLeaf directly)

### Terminology Notes

- **Leaf**: Means "tab" (don't confuse with sidebar panels)
- **activeDom**: Exists in both file explorer and tree (separate objects)
- **tree**: Not a tab's tree, but the tree widget inside a sidebar view
