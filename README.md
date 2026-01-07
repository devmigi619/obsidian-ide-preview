# ⚡ Smart Tabs (VS Code Style)

> Stop tab clutter. Browse notes like an IDE — with **panel-isolated preview tabs**.

**Smart Tabs (VS Code Style)** is an Obsidian plugin that replicates IDE-style tab behavior:
- **Single click** opens a note in a temporary **Preview tab**
- Preview auto-locks (becomes permanent) on **edit**
- Smart reuse prevents endless tab pile-up
- ✅ **Each panel manages its own preview tab independently**

---

## ✨ Features

### 1) Preview tabs (per panel)
- Single-click a file in the File Explorer to open it in a **Preview tab**.
- Each panel (tab group) keeps **exactly one preview tab**.

### 2) Auto-lock (promote to permanent)
A preview tab becomes a normal (permanent) tab when:
- You start editing the note
- You rename the note
- You double-click the tab header

### 3) Double click opens a permanent tab in the active panel
- Double-clicking a file opens it as a **permanent tab inside the currently active panel**
- The plugin does **not** jump to another panel automatically

### 4) Smart reuse
- Browsing files replaces the preview tab instead of creating endless new tabs.
- Optional: reuse an **empty tab** ("New Tab") in the active panel.

### 5) Duplicate handling (same panel only)
- If the file is already open in the **same panel**, you can optionally focus that tab instead of opening it again.
- This is **panel-isolated** by design (no cross-panel jumping).

---

## ⚙️ Settings

Go to `Settings → Smart Tabs (VS Code Style)`:

- **Italic title for preview**
  - Show preview tabs with italic titles (best-effort UI).
- **Reuse empty tab (locality)**
  - Use the active empty tab in the current panel when possible.
- **Promote old preview (same panel only)**
  - When moving preview within a panel, keep the old preview as a permanent tab.
- **Focus existing tab (same panel only)**
  - If the file is already open in the same panel, focus it instead of opening a duplicate.
- **Open new tab at the end**
  - Create new tabs at the end of the tab bar in the current panel.

---

## 📦 Installation

### Option 1: Using BRAT (Recommended for beta)
1. Install the **BRAT** plugin from Community Plugins.
2. Open BRAT settings and click **Add Beta plugin**.
3. Paste this repository URL: `https://github.com/devmigi/obsidian-ide-preview`
4. Click **Add Plugin**, then enable it in Obsidian.

### Option 2: Manual installation
1. Download the latest `main.js`, `manifest.json`, and `styles.css` from Releases.
2. Create a folder named **`ide-style-preview`** in your vault:
   - `<your vault>/.obsidian/plugins/ide-style-preview/`
3. Put the files in that folder.
4. Reload Obsidian and enable the plugin.

---

## ⚠️ Compatibility notes (best-effort)

This plugin uses a few workspace internals on a best-effort basis to:
- create/restore tabs inside the active panel, and
- apply preview styling to tab headers.

If Obsidian changes internal layout APIs in a future version:
- core behavior will continue to work in most cases,
- but exact tab placement/restoration position or italic styling may degrade.

Note:
- Some internal operations are queued with `setTimeout(..., 0)` to run after the current UI update cycle.
  This is for ordering/stability, not time-based behavior.

---

## 🤝 Contributing

Contributions are welcome! If you find a bug or have a feature request, please open an issue.

---

## 💬 Contact & Support

- Issues: https://github.com/devmigi/obsidian-ide-preview/issues
- Email: devmigi619@gmail.com

---

## 📄 License

MIT License