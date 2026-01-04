# ⚡ Obsidian IDE Style Preview

> Stop the tab clutter. Make your Obsidian tabs behave like VS Code.

**IDE Style Preview** is an Obsidian plugin that introduces a "Preview Mode" for tabs. It keeps your workspace clean by reusing tabs for browsing files, just like your favorite IDE (VS Code, IntelliJ).

## ✨ Features

- **Preview Mode (Italic Title)**: Clicking a file opens it in a temporary "preview" tab with an *italicized title*.
- **Smart Tab Reuse**:
  - Clicking another file **replaces** the current preview tab.
  - No more infinite tab pile-up when browsing files!
- **Auto-Locking (Permanent)**:
  - **Double-click** the file or tab header to keep it open.
  - **Start editing** the note to automatically lock it.
  - Locked tabs have normal titles and won't be replaced.
- **Empty Tab Utilization**: If you have an empty tab ('New Tab') open, clicking a file will use *that* tab instead of creating a new one.
- **Duplicate Detection**: If a file is already open somewhere else, clicking it will just **jump** to that tab.

## ⚙️ Settings

You can customize the behavior in `Settings > IDE Style Preview`:

- **Italic Title**: Toggle the visual cue (italic text) for preview tabs.
- **Reuse Empty Tab**: Use the currently active empty tab for new files.
- **Promote Old Preview**: When opening a new preview in a new location, keep the old preview tab as a regular tab (instead of closing it).
- **Focus Existing Tab**: Jump to an existing tab if the file is already open.

## 📦 Installation

### Option 1: Using BRAT (Recommended for Beta)
1. Install the **BRAT** plugin from the Community Plugins.
2. Open BRAT settings and click **"Add Beta plugin"**.
3. Paste this repository URL: `https://github.com/devmigi/obsidian-ide-preview`
4. Click **Add Plugin**.

### Option 2: Manual Installation
1. Download the latest `main.js`, `manifest.json`, and `styles.css` from the [Releases](https://github.com/devmigi/obsidian-ide-preview/releases) page.
2. Create a folder named `obsidian-ide-preview` in your vault's `.obsidian/plugins/` directory.
3. Put the files in that folder.
4. Reload Obsidian.

## 🤝 Contributing

Contributions are welcome! If you find a bug or have a feature request, please open an issue.

## 💬 Contact & Support

If you have any questions, bug reports, or feature requests, please feel free to [open an issue](https://github.com/devmigi/obsidian-ide-preview/issues) on GitHub.

For direct inquiries, you can reach me at: **devmigi619@gmail.com**

## 📄 License

MIT License
