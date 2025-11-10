# 🧠 Session Saver for VS Code

Save and restore open files (tabs) as named editing sessions -- perfect for seemlessly switching among devices when developing on remote (SSH), and maintaining the same editing experience. Open tabs and the cursor positions will be saved, so you can quickly get back to where you left off.

---

## ✨ Features

- 💾 Save the current set of open files as a named session  
- 🔄 Reload a session instantly to get back to work  
- ❌ Delete sessions you no longer need  
- 🗂️ Choose where sessions are stored (workspace, global storage, or any custom folder)  
- 🧭 Restore every tab exactly how you left it — order, split groups, and cursor positions  

---

## 🆕 What’s New

- Full workspace snapshots: sessions store editor groups, tab order, and cursor positions so restores are pixel-perfect.
- Flexible storage: pick per-session directories (workspace `.vscode/sessions`, VS Code global storage, or any custom folder) and switch locations via a command or the sidebar.
- Restore safety net: configure whether Session Saver should auto-save current tabs, skip saving, or always ask before switching sessions.
- Quick clean-up: delete individual sessions or wipe the entire session folder (respecting your chosen storage location) directly from the sidebar or Command Palette.

---

## 📋 What Gets Saved

Each session captures every open text tab (across all editor groups), their order, which tab was active, and the cursor position of any visible editor. Restoring a session replays that layout so your workspace looks exactly the way it did when you saved it. Tabs that aren’t part of the session trigger a prompt so you can decide whether to close them before the restore continues.

---

## 🚀 Commands

| Command                                        | Description                                                        |
|------------------------------------------------|--------------------------------------------------------------------|
| `Session Saver: Save Session`                | Capture every open tab (plus layout + cursor positions)            |
| `Session Saver: Restore Session`             | Pick and restore a saved session                                   |
| `Session Saver: Restore Named Session`       | Restore a specific session (used by the sidebar tree)              |
| `Session Saver: Delete Session`              | Remove a single saved session file                                 |
| `Session Saver: Overwrite Session`           | Replace an existing session with the currently open tabs           |
| `Session Saver: Change File Location`        | Switch where session files are stored (workspace/global/custom)    |
| `Session Saver: Delete All Sessions`         | Purge every saved session in the active storage location           |

Access these via the **Command Palette** (`Ctrl+Shift+P` or `Cmd+Shift+P`).

---

## 💾 Where Sessions Are Stored

By default, Session Saver stores files inside your workspace under a `sessions` folder.  
You can change this via **Session Saver: Change File Location** or the extension settings to pick:

- **Workspace** – Saved alongside your project (default)
- **Global Storage** – Stored with VS Code’s user data
- **Custom Folder** – Any folder you pick from disk

Feel free to back up, sync, or edit these JSON files manually.

---

## ⚙️ Settings

| Setting                               | Default     | Description |
|---------------------------------------|-------------|-------------|
| `sessionBuilder.fileLocation`         | `workspace` | Storage root for session files (`workspace`, `global`, or `custom`). |
| `sessionBuilder.workspaceFolder`      | _(blank)_   | Optional absolute path used when `fileLocation` = `workspace`. Leave empty to use the first open workspace. |
| `sessionBuilder.customFolder`         | _(blank)_   | Absolute path used when `fileLocation` = `custom`. Prompted the first time if left empty. |
| `sessionBuilder.saveBehaviorOnRestore`| `ask`       | Controls whether Session Saver prompts to save current tabs before restoring another session (`ask`, `yes - save and continue`, `no - just switch`). |

Settings can be configured per user, remote, or workspace scope—if a scope is left unset, it inherits from the next-highest level.

---

## 📦 Installation

```bash
code --install-extension monkey-sheng.session-builder
Or find it on the Visual Studio Marketplace.
```
