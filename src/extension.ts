import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_FOLDER_NAME = 'sessions';

type SessionLocationSetting = 'workspace' | 'global' | 'custom';
type SaveBehaviorSetting = 'ask' | 'yes - save and continue' | 'no - just switch';
type SaveBehaviorInternal = 'ask' | 'yes' | 'no';

interface SessionFileRecord {
  name: string;
  fullPath: string;
}

interface SavedCursorPosition {
  line: number;
  character: number;
}

interface SavedTabState {
  uri: string;
  groupIndex: number;
  tabIndex: number;
  viewColumn?: vscode.ViewColumn;
  isGroupActive: boolean;
  isGlobalActive: boolean;
  cursor?: SavedCursorPosition;
}

interface SessionFileContent {
  version: number;
  tabs: SavedTabState[];
}

interface ResolveOptions {
  promptUser?: boolean;
  showWarning?: boolean;
  ensureExists?: boolean;
}

const SESSION_FILE_VERSION = 2;
const lastKnownCursorPositions = new Map<string, SavedCursorPosition>();

let sessionTreeProvider: SessionProvider;

export function activate(context: vscode.ExtensionContext) {
  initializeCursorTracking(context);
  registerSaveSessionCommand(context);
  registerRestoreSessionCommand(context);
  registerRestoreNamedSessionCommand(context);
  registerDeleteSessionCommand(context);
  registerOverwriteSessionCommand(context);
  registerChangeLocationCommand(context);
  registerDeleteAllSessionsCommand(context);
  registerSidebarTreeView(context);
}

export function deactivate() {}


//#region Configuration helpers

function getConfiguration() {
  return vscode.workspace.getConfiguration('sessionSaver');
}

function getConfigurationTarget(key: string): vscode.ConfigurationTarget {
  const inspect = getConfiguration().inspect(key);
  if (!inspect) {
    return vscode.ConfigurationTarget.Global;
  }

  if (inspect.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }

  if (inspect.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }

  if (inspect.globalValue !== undefined) {
    return vscode.ConfigurationTarget.Global;
  }

  return vscode.ConfigurationTarget.Global;
}

function getFileLocationSetting(): SessionLocationSetting {
  const config = getConfiguration();
  return config.get<SessionLocationSetting>('fileLocation', 'workspace');
}

function getAutoSaveBehavior(): SaveBehaviorInternal {
  const config = getConfiguration();
  const setting = config.get<SaveBehaviorSetting>('saveBehaviorOnRestore', 'ask');
  if (setting === 'yes - save and continue') {
    return 'yes';
  }
  if (setting === 'no - just switch') {
    return 'no';
  }
  return 'ask';
}

async function updateConfigValue<T>(key: string, value: T) {
  const target = getConfigurationTarget(key);
  await getConfiguration().update(key, value, target);
}

async function ensureDirectory(dirPath: string) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function selectFolderDialog(title: string, openLabel: string): Promise<string | undefined> {
  const pick = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel,
    title
  });

  if (!pick || pick.length === 0) {
    return undefined;
  }

  return pick[0].fsPath;
}

async function resolveWorkspaceBase(promptUser: boolean, showWarning: boolean): Promise<string | undefined> {
  const config = getConfiguration();
  const stored = config.get<string>('workspaceFolder');
  if (stored && fs.existsSync(stored)) {
    return stored;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    if (showWarning) {
      vscode.window.showWarningMessage('No workspace folder is open. Please open a workspace or change the storage location.');
    }
    return undefined;
  }

  if (folders.length === 1 || !promptUser) {
    const folderPath = folders[0].uri.fsPath;
    await updateConfigValue('workspaceFolder', folderPath);
    return folderPath;
  }

  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select a workspace folder to store Session Saver files'
  });

  if (!picked) {
    return undefined;
  }

  await updateConfigValue('workspaceFolder', picked.uri.fsPath);
  return picked.uri.fsPath;
}

async function resolveCustomBase(promptUser: boolean, showWarning: boolean): Promise<string | undefined> {
  const config = getConfiguration();
  const stored = config.get<string>('customFolder');
  if (stored && fs.existsSync(stored)) {
    return stored;
  }

  if (!promptUser) {
    if (showWarning) {
      vscode.window.showWarningMessage('Custom session folder is not configured. Please set it via the Session Saver settings or command.');
    }
    return undefined;
  }

  const selected = await selectFolderDialog('Select a folder to store Session Saver files', 'Use Folder');
  if (!selected) {
    return undefined;
  }

  await updateConfigValue('customFolder', selected);
  return selected;
}

async function resolveSessionDirectory(context: vscode.ExtensionContext, options: ResolveOptions = {}): Promise<string | undefined> {
  const {
    promptUser = true,
    showWarning = true,
    ensureExists = false
  } = options;

  const location = getFileLocationSetting();
  let basePath: string | undefined;

  if (location === 'global') {
    basePath = context.globalStorageUri.fsPath;
  } else if (location === 'workspace') {
    basePath = await resolveWorkspaceBase(promptUser, showWarning);
  } else {
    basePath = await resolveCustomBase(promptUser, showWarning);
  }

  if (!basePath) {
    return undefined;
  }

  const sessionFolder = location === 'workspace'
    ? path.join(basePath, '.vscode', SESSION_FOLDER_NAME)
    : path.join(basePath, SESSION_FOLDER_NAME);

  if (ensureExists) {
    await ensureDirectory(sessionFolder);
  }

  return sessionFolder;
}

async function listSessions(context: vscode.ExtensionContext, options: ResolveOptions = {}): Promise<{ entries: SessionFileRecord[]; folder?: string }> {
  const folder = await resolveSessionDirectory(context, options);
  if (!folder || !fs.existsSync(folder)) {
    return { entries: [], folder };
  }

  const files = await fs.promises.readdir(folder);
  const entries = files
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const fullPath = path.join(folder, file);
      return {
        name: path.basename(file, '.json'),
        fullPath
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return { entries, folder };
}

function describeLocationLabel(): string {
  const location = getFileLocationSetting();
  const config = getConfiguration();

  if (location === 'global') {
    return 'Global Storage';
  }

  if (location === 'workspace') {
    const stored = config.get<string>('workspaceFolder');
    return stored ? `Workspace (${stored})` : 'Workspace (default)';
  }

  const custom = config.get<string>('customFolder');
  return custom ? `Custom (${custom})` : 'Custom (not configured)';
}

function initializeCursorTracking(context: vscode.ExtensionContext) {
  const seedVisibleEditors = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      const position = editor.selection.active;
      lastKnownCursorPositions.set(editor.document.uri.toString(), {
        line: position.line,
        character: position.character
      });
    }
  };

  seedVisibleEditors();

  const selectionListener = vscode.window.onDidChangeTextEditorSelection(event => {
    const position = event.textEditor.selection.active;
    lastKnownCursorPositions.set(event.textEditor.document.uri.toString(), {
      line: position.line,
      character: position.character
    });
  });

  const visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors(() => {
    seedVisibleEditors();
  });

  const closeDocListener = vscode.workspace.onDidCloseTextDocument(doc => {
    lastKnownCursorPositions.delete(doc.uri.toString());
  });

  context.subscriptions.push(selectionListener, visibleEditorsListener, closeDocListener);
}

function recordCursorPosition(uri: vscode.Uri, position: vscode.Position) {
  lastKnownCursorPositions.set(uri.toString(), {
    line: position.line,
    character: position.character
  });
}

function getTabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (!input) {
    return undefined;
  }

  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }

  if (input instanceof vscode.TabInputTextDiff) {
    return input.modified;
  }

  const mergeCtor = (vscode as typeof vscode & { TabInputTextMerge?: new (...args: never[]) => unknown }).TabInputTextMerge;
  if (mergeCtor && input instanceof mergeCtor) {
    const destination = (input as { destination?: vscode.Uri }).destination;
    if (destination) {
      return destination;
    }
  }

  return undefined;
}

function collectTextTabs(): Array<{ tab: vscode.Tab; uri: vscode.Uri; group: vscode.TabGroup; groupIndex: number; tabIndex: number }> {
  const results: Array<{ tab: vscode.Tab; uri: vscode.Uri; group: vscode.TabGroup; groupIndex: number; tabIndex: number }> = [];
  vscode.window.tabGroups.all.forEach((group, groupIndex) => {
    group.tabs.forEach((tab, tabIndex) => {
      const uri = getTabUri(tab);
      if (uri && uri.scheme === 'file') {
        results.push({ tab, uri, group, groupIndex, tabIndex });
      }
    });
  });
  return results;
}

function createSessionSnapshot(): SessionFileContent {
  const activeGroup = vscode.window.tabGroups.activeTabGroup;
  const tabs = collectTextTabs().map(({ tab, uri, group, groupIndex, tabIndex }) => {
    const cursor = lastKnownCursorPositions.get(uri.toString());
    return {
      uri: uri.toString(),
      groupIndex,
      tabIndex,
      viewColumn: group.viewColumn,
      isGroupActive: tab.isActive,
      isGlobalActive: activeGroup?.activeTab === tab,
      cursor
    } as SavedTabState;
  });

  return {
    version: SESSION_FILE_VERSION,
    tabs
  };
}

async function readSessionFile(filePath: string): Promise<SessionFileContent | undefined> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tabs)) {
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        tabs: parsed.tabs as SavedTabState[]
      };
    }
    vscode.window.showWarningMessage(`Session file is invalid: ${filePath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      vscode.window.showWarningMessage(`Session file not found: ${filePath}`);
    } else {
      vscode.window.showWarningMessage(`Failed to read session file: ${filePath}`);
      console.error(err);
    }
  }
  return undefined;
}

async function restoreSessionFromEntry(entry: SessionFileRecord): Promise<void> {
  const sessionData = await readSessionFile(entry.fullPath);
  if (!sessionData) {
    return;
  }

  if (!Array.isArray(sessionData.tabs) || sessionData.tabs.length === 0) {
    vscode.window.showWarningMessage(`Session "${entry.name}" does not contain any tabs.`);
    return;
  }

  const sessionUris = new Set(sessionData.tabs.map(tab => tab.uri));
  const currentTabs = collectTextTabs();

  for (const { tab, uri } of currentTabs) {
    if (!sessionUris.has(uri.toString())) {
      const choice = await vscode.window.showWarningMessage(
        `Tab \"${tab.label}\" is not part of the session \"${entry.name}\". Close it to continue restoring?`,
        { modal: true },
        'Close Tab',
        'Cancel Restore'
      );

      if (choice !== 'Close Tab') {
        vscode.window.showInformationMessage('Session restore canceled.');
        return;
      }

      await vscode.window.tabGroups.close(tab);
    }
  }

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  const sortedTabs = [...sessionData.tabs].sort((a, b) => {
    if (a.groupIndex === b.groupIndex) {
      if (a.isGroupActive === b.isGroupActive) {
        return a.tabIndex - b.tabIndex;
      }
      return a.isGroupActive ? 1 : -1;
    }
    return a.groupIndex - b.groupIndex;
  });

  let globalActive: SavedTabState | undefined;

  for (const tabState of sortedTabs) {
    const uri = vscode.Uri.parse(tabState.uri);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: tabState.viewColumn,
        preview: false,
        preserveFocus: true
      });

      if (tabState.cursor) {
        const position = new vscode.Position(tabState.cursor.line, tabState.cursor.character);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        recordCursorPosition(uri, position);
      }
    } catch (error) {
      vscode.window.showWarningMessage(`Failed to open file: ${uri.fsPath}`);
    }

    if (tabState.isGlobalActive) {
      globalActive = tabState;
    }
  }

  if (globalActive) {
    const uri = vscode.Uri.parse(globalActive.uri);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: globalActive.viewColumn,
        preview: false,
        preserveFocus: false
      });
      if (globalActive.cursor) {
        const position = new vscode.Position(globalActive.cursor.line, globalActive.cursor.character);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        recordCursorPosition(uri, position);
      }
    } catch (error) {
      console.error(error);
    }
  }

  vscode.window.showInformationMessage(`Restored session "${entry.name}".`);
}

async function pickSessionEntry(context: vscode.ExtensionContext, placeHolder: string): Promise<SessionFileRecord | undefined> {
  const { entries } = await listSessions(context, { promptUser: false, showWarning: true });

  if (entries.length === 0) {
    vscode.window.showWarningMessage('No sessions found.');
    return undefined;
  }

  const selection = await vscode.window.showQuickPick(
    entries.map(entry => ({
      label: entry.name,
      description: entry.fullPath,
      entry
    })),
    { placeHolder }
  );

  return selection?.entry;
}

async function entryFromArgument(context: vscode.ExtensionContext, arg?: SessionFileRecord | string): Promise<SessionFileRecord | undefined> {
  if (!arg) {
    return undefined;
  }

  if (typeof arg !== 'string') {
    if (fs.existsSync(arg.fullPath)) {
      return arg;
    }
    vscode.window.showWarningMessage(`Session file not found: ${arg.fullPath}`);
    return undefined;
  }

  const normalized = arg.endsWith('.json') ? arg : `${arg}.json`;
  if (fs.existsSync(normalized)) {
    return { name: path.basename(normalized, '.json'), fullPath: normalized };
  }

  const folder = await resolveSessionDirectory(context, { promptUser: false, showWarning: false });
  if (folder) {
    const candidate = path.join(folder, normalized);
    if (fs.existsSync(candidate)) {
      return { name: path.basename(candidate, '.json'), fullPath: candidate };
    }
  }

  vscode.window.showWarningMessage('Session file not found.');
  return undefined;
}

//#endregion


//#region Commands

function registerSaveSessionCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('session-saver.saveSession', async () => {
    let sessionName = await vscode.window.showInputBox({
      prompt: 'Enter a name for this session',
      placeHolder: 'Leave empty to use a timestamped name'
    });

    if (!sessionName) {
      sessionName = `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    }

    const snapshot = createSessionSnapshot();

    if (snapshot.tabs.length === 0) {
      vscode.window.showInformationMessage('No supported tabs to save.');
      return;
    }

    const sessionFolder = await resolveSessionDirectory(context, { promptUser: true, showWarning: true, ensureExists: true });
    if (!sessionFolder) {
      return;
    }

    const filePath = path.join(sessionFolder, `${sessionName}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');

    vscode.window.showInformationMessage(`Session "${sessionName}" saved with ${snapshot.tabs.length} tabs.`);
    sessionTreeProvider?.refresh();
  });

  context.subscriptions.push(disposable);
}

function registerRestoreSessionCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('session-saver.restoreSession', async () => {
    const entry = await pickSessionEntry(context, 'Select a session to restore');
    if (!entry) {
      return;
    }

    await restoreSessionFromEntry(entry);
  });

  context.subscriptions.push(disposable);
}

function registerRestoreNamedSessionCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('session-saver.restoreNamedSession', async (arg?: SessionFileRecord | string) => {
    let entry = await entryFromArgument(context, arg);
    if (!entry) {
      entry = await pickSessionEntry(context, 'Select a session to restore');
    }
    if (!entry) {
      return;
    }

    const hasOpenFiles = vscode.workspace.textDocuments.some(doc => !doc.isUntitled && !doc.isClosed);
    if (hasOpenFiles) {
      const behavior = getAutoSaveBehavior();
      let finalChoice: string | undefined;

      if (behavior === 'yes') {
        finalChoice = 'Yes — Save and Continue';
      } else if (behavior === 'no') {
        finalChoice = 'No — Just Switch';
      } else {
        finalChoice = await vscode.window.showQuickPick(
          ['Yes — Save and Continue', 'No — Just Switch', 'Cancel'],
          { placeHolder: 'Save current open files as a session before switching?' }
        );
      }

      if (finalChoice === 'Cancel' || !finalChoice) {
        return;
      }

      if (finalChoice === 'Yes — Save and Continue') {
        const unsavedDocs = vscode.workspace.textDocuments.filter(doc => doc.isDirty && !doc.isUntitled);
        if (unsavedDocs.length > 0) {
          const saveConfirm = await vscode.window.showQuickPick(
            ['💾 Save and Continue', '⚠️ Continue Without Saving', 'Cancel'],
            { placeHolder: `You have ${unsavedDocs.length} unsaved file(s). What do you want to do?` }
          );

          if (saveConfirm === '💾 Save and Continue') {
            await vscode.workspace.saveAll();
          } else if (saveConfirm === 'Cancel') {
            return;
          }
        }

        const snapshot = createSessionSnapshot();
        if (snapshot.tabs.length === 0) {
          vscode.window.showInformationMessage('No supported tabs to save.');
          return;
        }

        let sessionName = await vscode.window.showInputBox({
          prompt: 'Enter a name to save your current session',
          placeHolder: 'Leave empty to use a timestamped name'
        });

        if (!sessionName) {
          sessionName = `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        }

        const sessionFolder = await resolveSessionDirectory(context, { promptUser: true, showWarning: true, ensureExists: true });
        if (!sessionFolder) {
          return;
        }

        const savePath = path.join(sessionFolder, `${sessionName}.json`);
        await fs.promises.writeFile(savePath, JSON.stringify(snapshot, null, 2), 'utf8');
        vscode.window.showInformationMessage(`Session "${sessionName}" saved with ${snapshot.tabs.length} tabs.`);
        sessionTreeProvider?.refresh();
      } else if (finalChoice === 'Cancel' || !finalChoice) {
        return;
      }
    }

    await restoreSessionFromEntry(entry);
  });

  context.subscriptions.push(disposable);
}

function registerDeleteSessionCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('session-saver.deleteSession', async (arg?: SessionFileRecord | string) => {
    let entry = await entryFromArgument(context, arg);
    if (!entry) {
      entry = await pickSessionEntry(context, 'Select a session to delete');
    }
    if (!entry) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete session "${entry.name}"?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    if (fs.existsSync(entry.fullPath)) {
      await fs.promises.unlink(entry.fullPath);
    }

    vscode.window.showInformationMessage(`Deleted session "${entry.name}".`);
    sessionTreeProvider?.refresh();
  });

  context.subscriptions.push(disposable);
}

function registerOverwriteSessionCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('session-saver.overwriteSession', async (arg?: SessionFileRecord | string) => {
    let entry = await entryFromArgument(context, arg);
    if (!entry) {
      entry = await pickSessionEntry(context, 'Select a session to overwrite');
    }
    if (!entry) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Overwrite session "${entry.name}" with currently open files?`,
      { modal: true },
      'Overwrite'
    );

    if (confirm !== 'Overwrite') {
      return;
    }

    const unsavedDocs = vscode.workspace.textDocuments.filter(doc => doc.isDirty && !doc.isUntitled);
    if (unsavedDocs.length > 0) {
      const saveConfirm = await vscode.window.showQuickPick(
        ['💾 Save and Continue', '⚠️ Continue Without Saving', 'Cancel'],
        { placeHolder: `You have ${unsavedDocs.length} unsaved file(s). What do you want to do?` }
      );

      if (saveConfirm === '💾 Save and Continue') {
        await vscode.workspace.saveAll();
      } else if (saveConfirm === 'Cancel') {
        return;
      }
    }

    const snapshot = createSessionSnapshot();
    if (snapshot.tabs.length === 0) {
      vscode.window.showInformationMessage('No supported tabs to save.');
      return;
    }

    await ensureDirectory(path.dirname(entry.fullPath));
    await fs.promises.writeFile(entry.fullPath, JSON.stringify(snapshot, null, 2), 'utf8');

    vscode.window.showInformationMessage(`Session "${entry.name}" overwritten with ${snapshot.tabs.length} tabs.`);
    sessionTreeProvider?.refresh();
  });

  context.subscriptions.push(disposable);
}

function registerChangeLocationCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('session-saver.changeFileLocation', async () => {
    const location = getFileLocationSetting();
    const options: Array<{ label: string; value: SessionLocationSetting; description: string }> = [
      { label: 'Workspace', value: 'workspace', description: 'Store sessions inside a workspace folder' },
      { label: 'Global Storage', value: 'global', description: 'Store sessions inside VS Code global storage' },
      { label: 'Custom Folder…', value: 'custom', description: 'Choose any folder on disk' }
    ];

    const selection = await vscode.window.showQuickPick(
      options.map(opt => ({
        label: opt.label,
        description: opt.description,
        picked: opt.value === location,
        value: opt.value
      })),
      { placeHolder: 'Choose where Session Saver stores its files' }
    );

    if (!selection) {
      return;
    }

    if (selection.value === 'workspace') {
      const folder = await resolveWorkspaceBase(true, true);
      if (!folder) {
        return;
      }
      await updateConfigValue('fileLocation', 'workspace');
      vscode.window.showInformationMessage(`Session storage set to workspace folder: ${folder}`);
    } else if (selection.value === 'global') {
      await updateConfigValue('fileLocation', 'global');
      vscode.window.showInformationMessage('Session storage set to global storage.');
    } else {
      const folder = await resolveCustomBase(true, true);
      if (!folder) {
        return;
      }
      await updateConfigValue('fileLocation', 'custom');
      vscode.window.showInformationMessage(`Session storage set to custom folder: ${folder}`);
    }

    sessionTreeProvider?.refresh();
  });

  context.subscriptions.push(disposable);
}

function registerDeleteAllSessionsCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('session-saver.deleteAllSessions', async () => {
    const folder = await resolveSessionDirectory(context, { promptUser: false, showWarning: true });
    if (!folder || !fs.existsSync(folder)) {
      vscode.window.showInformationMessage('No session folder found.');
      return;
    }

    const files = (await fs.promises.readdir(folder)).filter(file => file.endsWith('.json'));
    if (files.length === 0) {
      vscode.window.showInformationMessage('No sessions to delete.');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete all ${files.length} session(s) in ${folder}?`,
      { modal: true },
      'Delete All'
    );

    if (confirm !== 'Delete All') {
      return;
    }

    await Promise.all(files.map(file => fs.promises.unlink(path.join(folder, file))));
    vscode.window.showInformationMessage(`Deleted ${files.length} session(s).`);
    sessionTreeProvider?.refresh();
  });

  context.subscriptions.push(disposable);
}

//#endregion



//#region Sidebar View

function registerSidebarTreeView(context: vscode.ExtensionContext) {
  sessionTreeProvider = new SessionProvider(context);
  // view id updated to match package.json change
  vscode.window.registerTreeDataProvider('sessionSaverView', sessionTreeProvider);
}

type SessionItemKind = 'session' | 'restore' | 'delete' | 'filesRoot' | 'fileEntry' | 'info' | 'command';

class SessionItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: SessionItemKind,
    public readonly entry?: SessionFileRecord,
    public readonly fileEntryPath?: string,
    command?: vscode.Command
  ) {
    super(label, collapsibleState);
    if (command) {
      this.command = command;
    }
  }
}

class SessionProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SessionItem | undefined | void> = new vscode.EventEmitter<SessionItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<SessionItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SessionItem): Promise<SessionItem[]> {
    if (!element) {
      const results = await listSessions(this.context, { promptUser: false, showWarning: false });
      const items: SessionItem[] = [];

      const changeLocationItem = new SessionItem(
        '⚙️ Change Session Location',
        vscode.TreeItemCollapsibleState.None,
        'command',
        undefined,
        undefined,
        { command: 'session-saver.changeFileLocation', title: 'Change Session Location' }
      );

      const deleteAllItem = new SessionItem(
        '🧹 Delete All Sessions',
        vscode.TreeItemCollapsibleState.None,
        'command',
        undefined,
        undefined,
        { command: 'session-saver.deleteAllSessions', title: 'Delete All Sessions' }
      );

      const saveItem = new SessionItem(
        '💾 Save New Session',
        vscode.TreeItemCollapsibleState.None,
        'command',
        undefined,
        undefined,
        { command: 'session-saver.saveSession', title: 'Save Session' }
      );

      const locationLabel = describeLocationLabel();
      const locationItem = new SessionItem(`📁 Storage: ${locationLabel}`, vscode.TreeItemCollapsibleState.None, 'info');
      locationItem.tooltip = results.folder ?? 'Storage directory is not available.';

      items.push(saveItem, changeLocationItem, deleteAllItem, locationItem);

      if (results.entries.length > 0) {
        const headerItem = new SessionItem('───── Sessions ─────', vscode.TreeItemCollapsibleState.None, 'info');
        items.push(headerItem);
      }

      for (const entry of results.entries) {
        const sessionItem = new SessionItem(
          entry.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          'session',
          entry
        );
        sessionItem.tooltip = entry.fullPath;
        sessionItem.description = path.dirname(entry.fullPath);
        sessionItem.contextValue = 'session';
        items.push(sessionItem);
      }

      return items;
    }

    if (element.kind === 'session' && element.entry) {
      const restoreItem = new SessionItem(
        '📂 Restore Session',
        vscode.TreeItemCollapsibleState.None,
        'restore',
        element.entry,
        undefined,
        {
          command: 'session-saver.restoreNamedSession',
          title: 'Restore Session',
          arguments: [element.entry]
        }
      );

      const overwriteItem = new SessionItem(
        '📝 Overwrite Session',
        vscode.TreeItemCollapsibleState.None,
        'restore',
        element.entry,
        undefined,
        {
          command: 'session-saver.overwriteSession',
          title: 'Overwrite Session',
          arguments: [element.entry]
        }
      );

      const deleteItem = new SessionItem(
        '❌ Delete Session',
        vscode.TreeItemCollapsibleState.None,
        'delete',
        element.entry,
        undefined,
        {
          command: 'session-saver.deleteSession',
          title: 'Delete Session',
          arguments: [element.entry]
        }
      );

      const filesRootItem = new SessionItem(
        '📄 View Files',
        vscode.TreeItemCollapsibleState.Collapsed,
        'filesRoot',
        element.entry
      );

      return [restoreItem, overwriteItem, deleteItem, filesRootItem];
    }

    if (element.kind === 'filesRoot' && element.entry) {
      const sessionData = await readSessionFile(element.entry.fullPath);
      if (!sessionData) {
        return [];
      }

      return sessionData.tabs.map(tabState => {
        const uri = vscode.Uri.parse(tabState.uri);
        const filePath = uri.fsPath;
        const fileLabel = path.basename(filePath);
        const description = `Group ${tabState.groupIndex + 1}, Tab ${tabState.tabIndex + 1}`;

        const fileItem = new SessionItem(
          fileLabel,
          vscode.TreeItemCollapsibleState.None,
          'fileEntry',
          element.entry,
          filePath,
          {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [uri]
          }
        );
        fileItem.tooltip = `${filePath}\nCursor: ${tabState.cursor ? `${tabState.cursor.line + 1}:${tabState.cursor.character + 1}` : 'N/A'}`;
        fileItem.description = description;
        return fileItem;
      });
    }

    return [];
  }
}

//#endregion
