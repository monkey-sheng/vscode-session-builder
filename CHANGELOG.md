# Changelog

# Changelog

## [2.0.0] - 2025-11-10
### Added
- Session snapshots now capture editor groups, tab order, active state, and cursor positions for each file, ensuring pixel-perfect restores.
- Storage locations can be switched between workspace `.vscode/sessions`, VS Code global storage, or any custom folder via settings or the new command.
- Configurable restore behavior (`ask`, `yes - save and continue`, `no - just switch`) lets you skip the save prompt when switching sessions.
- Sidebar action and command to delete all saved sessions in the current storage location.

### Changed
- Workspace storage now saves under `.vscode/sessions` within the selected root.
- Session files are named automatically when no title is provided.

## [1.1.0] - 2025-05-05
### Added
- Overwrite Session command to replace saved sessions with currently open files
- Prompt to save unsaved files before switching sessions or overwriting

### Fixed
- `visibleTextEditors` replaced with `textDocuments` to include all open tabs
- Ensured dirty files are handled correctly based on user input

## [0.1.0] - 2025-05-02

### Added
- Save and load named file sessions
- JSON-based session storage under `~/.vscode-session-builder/`
- Load/Delete/List session commands in Command Palette
- Extension icon and Marketplace publishing support
