# Smart Tabs — Feature Specification

## 1. Overview

**Smart Tabs** is an Obsidian plugin that implements VS Code-style tab behavior. Browsing files does not pile up tabs; new tabs are only created when you explicitly open or edit a file.

### Tab States

| State | Description | Visual |
|-------|-------------|--------|
| **Empty** | Blank tab (nothing open) | - |
| **Preview** | Temporary tab, reused when another file is opened | Tab title in *italics* |
| **Permanent** | Persistent tab, kept until explicitly closed | Tab title in regular style |

---

## 2. Global Rules

Rules that apply to all actions.

### One Preview Per Panel

Each panel (tab group) can have at most **one** Preview tab.

**When opening a file as Preview:**
1. If a Preview tab already exists in the same panel → reuse it
2. Otherwise:
   - Current tab is Empty → open as Preview in that tab
   - Current tab is Permanent → create a new Preview tab

### Duplicate Prevention

Clicking a file or view that is already open in the same panel focuses the existing tab instead of creating a new one:
- **Files**: same file path → focus existing tab
- **Non-file views**: same view type (Graph, Canvas, etc.) → focus existing tab

### Modifier Key

Follows Obsidian's default behavior:
- **Ctrl/Cmd + Click**: Open in a new **Permanent** tab (ignoring existing tabs)

### Focus Management

- Newly created tabs receive focus automatically
- Closing a tab cleans up the file explorer's active state (`activeDom`, `has-focus` class, etc.)

---

## 3. Pattern Rules

### Browse Pattern (Standard Browsing)

Browsing a file. Opens in **Preview** mode.

| Current Tab | Action |
|-------------|--------|
| **Empty** | Open as **Preview** in current tab |
| **Permanent** | Reuse existing Preview tab; create new Preview if none |
| **Preview** | Replace with new **Preview** in current tab |

### Open Pattern (Explicit Open)

Explicit intent to open a file. Triggered by **double-click**.

| Current Tab | Action |
|-------------|--------|
| **Empty** | Open as **Permanent** in current tab |
| **Permanent** | Preserve → create new **Permanent** tab |
| **Preview** (different file) | Replace with **Permanent** in current tab |
| **Preview** (same file) | Promote to **Permanent** |

### Create Pattern (File Creation)

Creating a new file. Always opens as a **Permanent** tab.

| Current Tab | Action |
|-------------|--------|
| **Empty** | Create as **Permanent** in current tab |
| **Permanent** | Preserve → create new **Permanent** tab |
| **Preview** | Preserve → create new **Permanent** tab |

### Promote Pattern (Auto-Promotion)

Preview tabs are automatically promoted to Permanent when the following triggers occur.

| Trigger | Description |
|---------|-------------|
| **Body editing** | First keystroke in the editor |
| **Inline title editing** | Editing the note title (300ms debounce) |
| **File rename** | Renaming a Preview tab's file (vault.rename event) |
| **Canvas editing** | Adding/editing/deleting nodes or edges (vault.modify event) |
| **Double-click** | Double-clicking tab header or sidebar item |
| **Pin tab** | Pinning a Preview tab converts it to Permanent |

---

## 4. Pattern Exceptions

Cases where behavior differs from the base patterns.

### Preview Tab Preservation

When **creating a new note**, the current Preview tab is preserved (not replaced).

| Current Tab | Normal Browse | New Note Creation |
|-------------|--------------|-------------------|
| **Preview** | Replaced with Preview | **Preserved** → new Permanent created |

### Daily Notes Special Handling

Daily Notes are treated as **Create pattern** for both creation and reopening.

- Detection: auto-detected via the Daily Notes plugin settings (date format, folder path)

### Preview Takes Priority Over Empty

Even if an Empty tab exists, the existing Preview tab is reused first.

| Panel State | Browse Action |
|-------------|---------------|
| Preview + Empty | Reuse Preview (Empty not used) |
| Permanent + Empty | Open as Preview in Empty tab |

---

## 5. Feature Details

Specific behavior for each UI element.

### File Explorer

| Action | Pattern |
|--------|---------|
| Single click | Browse |
| Double click | Open |

### Quick Switcher (Ctrl+O)

| Action | Pattern |
|--------|---------|
| Select file | Browse |

### Bookmarks

| Action | Pattern |
|--------|---------|
| Single click | Browse |
| Double click | Open |

### File Search

| Action | Pattern |
|--------|---------|
| Single click | Browse |
| Double click | Open |

### Graph View

| Action | Pattern |
|--------|---------|
| Open graph view | Browse |
| Single-click node | Browse |

### Links

| Action | Pattern |
|--------|---------|
| Wiki-link click | Browse |
| Backlinks panel click | Browse |
| Outgoing Links panel click | Browse |

### Random Note

| Action | Pattern |
|--------|---------|
| Open random note | Browse |

> **Note**: Recent Files requires a separate plugin and is not supported.

### Canvas

| Action | Pattern |
|--------|---------|
| Canvas creation (ribbon button) | Create → Permanent |
| Canvas open (single click) | Browse → Preview |
| Canvas open (double click) | Open → Permanent |

**Canvas Promotion Cases:**
1. **Canvas editing** (auto-promotion):
   - Adding/editing/deleting nodes
   - Adding/editing/deleting edges
   - Dragging nodes
   - Opening node editor (double-click)
   - All Canvas content changes detected via `vault.modify` event

2. **File rename** (auto-promotion):
   - Renaming a Canvas file that is open in a Preview tab → detected via `vault.rename` event

3. **Double-click** (manual promotion):
   - Tab header double-click
   - File explorer / bookmarks / search result double-click

### PDF

| Action | Pattern |
|--------|---------|
| PDF open (single click) | Browse → Preview |
| PDF open (double click) | Browse → Preview → manual promotion available |

**PDF Characteristics:**
- Read-only (no editing possible)
- No auto-promotion (body editing, file modification won't trigger promotion)
- Manual promotion available (double-click to convert to Permanent)

### New Note Creation

| Trigger | Pattern |
|---------|---------|
| Ribbon button (new note) | Create |
| Ctrl+N / Cmd+N | Create |
| Right-click → New note | Create |
| Unique Note Creator | Create |
| Daily Notes | Create (special handling) |

---

## Appendix: Glossary

| Term | Description |
|------|-------------|
| **Panel** | Container holding a tab group. Can be split |
| **Leaf** | Obsidian's internal term for an individual tab |
| **View** | Content displayed inside a tab (Markdown editor, Graph, Canvas, etc.) |
| **Browse** | Intent to casually view a file |
| **Create** | Intent to create a new file |
| **Open** | Intent to explicitly open a file |
| **Promote** | Upgrading a Preview tab to Permanent |
