import * as vscode from "vscode";
import { Uri, FileType, QuickInputButton, ThemeIcon, ViewColumn } from "vscode";
import * as OS from "os";
import * as OSPath from "path";

import { Result, None, Option, Some } from "@bodil/opt";
import { Path, endsWithPathSeparator } from "./path";
import { Rules } from "./filter";
import { FileItem, fileRecordCompare } from "./fileitem";
import { action, Action } from "./action";

export enum ConfigItem {
    RemoveIgnoredFiles = "removeIgnoredFiles",
    HideDotfiles = "hideDotfiles",
    HideIgnoreFiles = "hideIgnoredFiles",
    IgnoreFileTypes = "ignoreFileTypes",
    LabelIgnoredFiles = "labelIgnoredFiles",
}

export function config<A>(item: ConfigItem): A | undefined {
    return vscode.workspace.getConfiguration("file-browser").get(item);
}

let active: Option<FileBrowser> = None;

function setContext(state: boolean) {
    vscode.commands.executeCommand("setContext", "inFileBrowser", state);
}

interface AutoCompletion {
    index: number;
    items: FileItem[];
}

class FileBrowser {
    current: vscode.QuickPick<FileItem>;
    path: Path;
    file: Option<string>;
    items: FileItem[] = [];
    pathHistory: { [path: string]: Option<string> };
    inActions: boolean = false;
    keepAlive: boolean = false;
    autoCompletion?: AutoCompletion;
    inSearchMode: boolean = false;
    inVisualMode: boolean = false;
    inRenameMode: boolean = false;
    inCreateMode: boolean = false;
    visualSelectionStart: number = -1;
    selectedItems: FileItem[] = [];

    actionsButton: QuickInputButton = {
        iconPath: new ThemeIcon("ellipsis"),
        tooltip: "Actions on selected file",
    };
    stepOutButton: QuickInputButton = {
        iconPath: new ThemeIcon("arrow-left"),
        tooltip: "Step out of folder",
    };
    stepInButton: QuickInputButton = {
        iconPath: new ThemeIcon("arrow-right"),
        tooltip: "Step into folder",
    };

    constructor(path: Path, file: Option<string>) {
        this.path = path;
        this.file = file;
        this.pathHistory = { [this.path.id]: this.file };
        this.current = vscode.window.createQuickPick();
        this.current.buttons = [this.actionsButton, this.stepOutButton, this.stepInButton];
        this.current.placeholder = "Preparing the file list...";
        
        // Custom key press handler to intercept ESC key
        // This is needed because VSCode's QuickPick automatically closes on ESC
        // We want to handle ESC based on the current mode
        this.current.onDidTriggerButton(this.onDidTriggerButton.bind(this));
        this.current.onDidAccept(this.onDidAccept.bind(this));
        this.current.onDidChangeValue(this.onDidChangeValue.bind(this));
        
        // Handle the QuickPick hide event
        this.current.onDidHide(() => {
            if (!this.keepAlive) {
                // If the tool is being closed normally, dispose of it
                this.dispose();
            } else {
                // If keepAlive is set, we're in the middle of an operation
                // that temporarily hides the QuickPick
            }
        });
        
        // Add a special key-press handler for ESC
        this.handleEscapeKey();
        
        this.update().then(() => {
            this.current.placeholder = "NORMAL mode (h,j,k,l to navigate | i for search | r to rename | d to delete | c for new file)";
            this.current.busy = false;
            this.setSearchMode(false);
            this.setVisualMode(false);
            vscode.commands.executeCommand("setContext", "file-browser.inRenameMode", false);
            vscode.commands.executeCommand("setContext", "file-browser.inCreateMode", false);
        });
    }

    // Custom handler for ESC key to prevent QuickPick from closing automatically
    private handleEscapeKey() {
        // Update the QuickPick whenever it gains focus to ensure our escape handler context is preserved
        this.current.onDidChangeActive(() => {
            vscode.commands.executeCommand('setContext', 'inFileBrowserEscapeHandler', true);
        });
    }

    dispose() {
        setContext(false);
        this.current.dispose();
        active = None;
    }

    hide() {
        this.current.hide();
        setContext(false);
    }

    show() {
        setContext(true);
        vscode.commands.executeCommand('setContext', 'inFileBrowserEscapeHandler', true);
        this.current.show();
    }

    async update() {
        // FIXME: temporary and UGLY fix of https://github.com/bodil/vscode-file-browser/issues/35.
        // Brought in from here https://github.com/atariq11700/vscode-file-browser/commit/a2525d01f262f17dac2c478e56640c9ce1f65713.
        // this.current.enabled = false;
        this.current.show();
        this.current.busy = true;
        this.current.title = this.path.fsPath;
        this.current.value = "";

        const stat = (await Result.await(vscode.workspace.fs.stat(this.path.uri))).unwrap();
        if (stat && this.inActions && (stat.type & FileType.File) === FileType.File) {
            this.items = [
                action("$(file) Open this file", Action.OpenFile),
                action("$(split-horizontal) Open this file to the side", Action.OpenFileBeside),
                action("$(edit) Rename this file", Action.RenameFile),
                action("$(trash) Delete this file", Action.DeleteFile),
            ];
            this.current.items = this.items;
        } else if (
            stat &&
            this.inActions &&
            (stat.type & FileType.Directory) === FileType.Directory
        ) {
            this.items = [
                action("$(folder-opened) Open this folder", Action.OpenFolder),
                action(
                    "$(folder-opened) Open this folder in a new window",
                    Action.OpenFolderInNewWindow
                ),
                action("$(edit) Rename this folder", Action.RenameFile),
                action("$(trash) Delete this folder", Action.DeleteFile),
            ];
            this.current.items = this.items;
        } else if (stat && (stat.type & FileType.Directory) === FileType.Directory) {
            const records = await vscode.workspace.fs.readDirectory(this.path.uri);
            records.sort(fileRecordCompare);
            let items = records.map((entry) => new FileItem(entry));
            if (config(ConfigItem.HideIgnoreFiles)) {
                const rules = await Rules.forPath(this.path);
                items = rules.filter(this.path, items);
            }
            if (config(ConfigItem.RemoveIgnoredFiles)) {
                items = items.filter((item) => item.alwaysShow);
            }
            this.items = items;
            this.current.items = items;
            this.current.activeItems = items.filter((item) => this.file.value === item.name);
        } else {
            this.items = [action("$(new-folder) Create this folder", Action.NewFolder)];
            this.current.items = this.items;
        }
        this.current.enabled = true;
    }

    onDidChangeValue(value: string, isAutoComplete = false) {
        if (this.inActions) {
            return;
        }

        // In normal mode, prevent typing unless in rename, search, or create mode
        if (!this.inSearchMode && !this.inRenameMode && !this.inCreateMode) {
            // Reset the value to empty if the user tries to type
            if (value !== "") {
                this.current.value = "";
            }
            return;
        }

        // In visual mode, prevent typing unless in rename or create mode
        if (this.inVisualMode && !this.inRenameMode && !this.inCreateMode) {
            // Reset the value to empty if the user tries to type
            if (value !== "") {
                this.current.value = "";
            }
            return;
        }

        if (!isAutoComplete) {
            this.autoCompletion = undefined;
        }

        const existingItem = this.items.find((item) => item.name === value);
        if (value === "") {
            this.current.items = this.items;
            this.current.activeItems = [];
        } else if (existingItem !== undefined) {
            this.current.items = this.items;
            this.current.activeItems = [existingItem];
        } else {
            endsWithPathSeparator(value).match(
                (path) => {
                    if (path === "~") {
                        this.stepIntoFolder(Path.fromFilePath(OS.homedir()));
                    } else if (path === "..") {
                        this.stepOut();
                    } else {
                        this.stepIntoFolder(this.path.append(path));
                    }
                },
                () => {
                    // Filter items based on search input
                    if (this.inSearchMode || this.inRenameMode || this.inCreateMode) {
                        const filtered = this.items.filter((item) =>
                            item.name.toLowerCase().includes(value.toLowerCase())
                        );
                        this.current.items = filtered;
                        if (filtered.length > 0) {
                            this.current.activeItems = [filtered[0]];
                        } else {
                            const newItem = {
                                label: `$(new-file) ${value}`,
                                name: value,
                                description: "Open as new file",
                                alwaysShow: true,
                                action: Action.NewFile,
                            };
                            this.current.items = [newItem];
                            this.current.activeItems = [newItem];
                        }
                    } else {
                        const newItem = {
                            label: `$(new-file) ${value}`,
                            name: value,
                            description: "Open as new file",
                            alwaysShow: true,
                            action: Action.NewFile,
                        };
                        this.current.items = [newItem, ...this.items];
                        this.current.activeItems = [newItem];
                    }
                }
            );
        }
    }

    onDidTriggerButton(button: QuickInputButton) {
        if (button === this.stepInButton) {
            this.stepIn();
        } else if (button === this.stepOutButton) {
            this.stepOut();
        } else if (button === this.actionsButton) {
            this.actions();
        }
    }

    activeItem(): Option<FileItem> {
        return Option.from(this.current.activeItems[0]);
    }

    async stepIntoFolder(folder: Path) {
        if (!this.path.equals(folder)) {
            this.path = folder;
            this.file = this.pathHistory[this.path.id] || None;
            await this.update();
        }
    }

    async stepIn() {
        this.activeItem().ifSome(async (item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (item.fileType !== undefined) {
                if ((item.fileType & FileType.Directory) === FileType.Directory) {
                    await this.stepIntoFolder(this.path.append(item.name));
                } else if ((item.fileType & FileType.File) === FileType.File) {
                    this.path.push(item.name);
                    this.file = None;
                    this.inActions = true;
                    await this.update();
                }
            }
        });
    }

    async stepOut() {
        this.inActions = false;
        if (!this.path.atTop()) {
            this.pathHistory[this.path.id] = this.activeItem().map((item) => item.name);
            this.file = this.path.pop();
            await this.update();
        }
    }

    async actions() {
        if (this.inActions) {
            return;
        }
        await this.activeItem().match(
            async (item) => {
                this.inActions = true;
                this.path.push(item.name);
                this.file = None;
                await this.update();
            },
            async () => {
                this.inActions = true;
                this.file = None;
                await this.update();
            }
        );
    }

    tabCompletion(tabNext: boolean) {
        if (this.inActions) {
            return;
        }

        if (this.autoCompletion) {
            const length = this.autoCompletion.items.length;
            const step = tabNext ? 1 : -1;
            this.autoCompletion.index = (this.autoCompletion.index + length + step) % length;
        } else {
            const items = this.items.filter((i) =>
                i.name.toLowerCase().startsWith(this.current.value.toLowerCase())
            );
            this.autoCompletion = {
                index: tabNext ? 0 : items.length - 1,
                items,
            };
        }

        const newIndex = this.autoCompletion.index;
        const length = this.autoCompletion.items.length;
        if (newIndex < length) {
            // This also checks out when items is empty
            const item = this.autoCompletion.items[newIndex];
            this.current.value = item.name;
            if (length === 1 && item.fileType === FileType.Directory) {
                this.current.value += "/";
            }

            this.onDidChangeValue(this.current.value, true);
        }
    }

    onDidAccept() {
        this.autoCompletion = undefined;
        
        // If in create mode, create the new file
        if (this.inCreateMode && this.current.value !== "") {
            const newFileName = this.current.value;
            this.inCreateMode = false;
            this.openFile(this.path.append(newFileName).uri.with({ scheme: "untitled" }));
            return;
        }
        
        // If in rename mode, handle the rename
        if (this.inRenameMode && this.current.value !== "") {
            const oldName = this.file.getOrElse(() => "");
            const newName = this.current.value;
            
            if (oldName && newName && oldName !== newName) {
                // Handle the rename
                this.keepAlive = true;
                this.hide();
                
                const oldUri = this.path.append(oldName).uri;
                const newUri = this.path.append(newName).uri;
                
                vscode.workspace.fs.rename(oldUri, newUri).then(
                    () => {
                        // Reset state and update the file browser
                        this.inRenameMode = false;
                        this.inVisualMode = false;
                        this.file = None;
                        this.show();
                        this.keepAlive = false;
                        this.update();
                    },
                    (error) => {
                        vscode.window.showErrorMessage(`Failed to rename "${oldName}" to "${newName}"`);
                        this.inRenameMode = false;
                        this.show();
                        this.keepAlive = false;
                    }
                );
            } else {
                this.inRenameMode = false;
            }
            return;
        }
        
        // If in search mode, select the item and exit search mode
        if (this.inSearchMode) {
            // Only exit search mode if we actually select something
            if (this.current.activeItems.length > 0) {
                this.setSearchMode(false);
            }
        }
        
        // If in visual mode, perform action on all selected items
        if (this.inVisualMode && this.selectedItems.length > 0) {
            // For now, we'll just exit visual mode and select the current item
            this.setVisualMode(false);
        }
        
        this.activeItem().ifSome((item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (
                item.fileType !== undefined &&
                (item.fileType & FileType.Directory) === FileType.Directory
            ) {
                this.stepIn();
            } else {
                this.openFile(this.path.append(item.name).uri);
            }
        });
    }

    openFile(uri: Uri, column: ViewColumn = ViewColumn.Active) {
        this.dispose();
        vscode.workspace
            .openTextDocument(uri)
            .then((doc) => vscode.window.showTextDocument(doc, column));
    }

    async rename() {
        const uri = this.path.uri;
        const stat = await vscode.workspace.fs.stat(uri);
        const isDir = (stat.type & FileType.Directory) === FileType.Directory;
        const fileName = this.path.pop().getOrElse(() => {
            throw new Error("Can't rename an empty file name!");
        });
        const fileType = isDir ? "folder" : "file";
        const workspaceFolder = this.path.getWorkspaceFolder().map((wsf) => wsf.uri);
        const relPath = workspaceFolder
            .chain((workspaceFolder) => new Path(uri).relativeTo(workspaceFolder))
            .getOr(fileName);
        const extension = OSPath.extname(relPath);
        const startSelection = relPath.length - fileName.length;
        const endSelection = startSelection + (fileName.length - extension.length);
        const result = await vscode.window.showInputBox({
            prompt: `Enter the new ${fileType} name`,
            value: relPath,
            valueSelection: [startSelection, endSelection],
        });
        this.file = Some(fileName);
        if (result !== undefined) {
            const newUri = workspaceFolder.match(
                (workspaceFolder) => Uri.joinPath(workspaceFolder, result),
                () => Uri.joinPath(this.path.uri, result)
            );
            if ((await Result.await(vscode.workspace.fs.rename(uri, newUri))).isOk()) {
                this.file = Some(OSPath.basename(result));
            } else {
                vscode.window.showErrorMessage(`Failed to rename ${fileType} "${fileName}"`);
            }
        }
    }

    async runAction(item: FileItem) {
        switch (item.action) {
            case Action.NewFolder: {
                await vscode.workspace.fs.createDirectory(this.path.uri);
                await this.update();
                break;
            }
            case Action.NewFile: {
                const uri = this.path.append(item.name).uri;
                this.openFile(uri.with({ scheme: "untitled" }));
                break;
            }
            case Action.OpenFile: {
                const path = this.path.clone();
                if (item.name && item.name.length > 0) {
                    path.push(item.name);
                }
                this.openFile(path.uri);
                break;
            }
            case Action.OpenFileBeside: {
                const path = this.path.clone();
                if (item.name && item.name.length > 0) {
                    path.push(item.name);
                }
                this.openFile(path.uri, ViewColumn.Beside);
                break;
            }
            case Action.RenameFile: {
                this.keepAlive = true;
                this.hide();
                await this.rename();
                this.show();
                this.keepAlive = false;
                this.inActions = false;
                this.update();
                break;
            }
            case Action.DeleteFile: {
                this.keepAlive = true;
                this.hide();
                const uri = this.path.uri;
                const stat = await vscode.workspace.fs.stat(uri);
                const isDir = (stat.type & FileType.Directory) === FileType.Directory;
                const fileName = this.path.pop().getOrElse(() => {
                    throw new Error("Can't delete an empty file name!");
                });
                const fileType = isDir ? "folder" : "file";
                const goAhead = `$(trash) Delete the ${fileType} "${fileName}"`;
                const result = await vscode.window.showQuickPick(["$(close) Cancel", goAhead], {});
                if (result === goAhead) {
                    const delOp = await Result.await(
                        vscode.workspace.fs.delete(uri, { recursive: isDir })
                    );
                    if (delOp.isErr()) {
                        vscode.window.showErrorMessage(
                            `Failed to delete ${fileType} "${fileName}"`
                        );
                    }
                }
                this.show();
                this.keepAlive = false;
                this.inActions = false;
                this.update();
                break;
            }
            case Action.OpenFolder: {
                vscode.commands.executeCommand("vscode.openFolder", this.path.uri);
                break;
            }
            case Action.OpenFolderInNewWindow: {
                vscode.commands.executeCommand("vscode.openFolder", this.path.uri, true);
                break;
            }
            default:
                throw new Error(`Unhandled action ${item.action}`);
        }
    }

    setSearchMode(isSearchMode: boolean) {
        this.inSearchMode = isSearchMode;
        this.inRenameMode = false;
        this.inCreateMode = false;
        vscode.commands.executeCommand("setContext", "file-browser.inSearchMode", isSearchMode);
        
        if (isSearchMode) {
            // Exit visual mode if entering search/insert mode
            this.setVisualMode(false);
        }
        
        if (!isSearchMode) {
            // Clear the search and reset the items
            this.current.value = "";
            this.current.items = this.items;
            this.current.placeholder = "NORMAL mode (h,j,k,l to navigate | i for search | r to rename | d to delete | c for new file)";
        } else {
            this.current.placeholder = "INSERT mode (ESC to exit)";
        }
    }

    toggleSearchMode() {
        this.setSearchMode(!this.inSearchMode);
    }

    exitSearchMode() {
        this.setSearchMode(false);
        // Prevent the tool from closing by stopping event propagation
        this.current.show();
    }

    setVisualMode(isVisualMode: boolean) {
        this.inVisualMode = isVisualMode;
        vscode.commands.executeCommand("setContext", "file-browser.inVisualMode", isVisualMode);
        
        if (isVisualMode) {
            // Exit search/rename/create mode if entering visual mode
            this.inSearchMode = false;
            this.inRenameMode = false;
            this.inCreateMode = false;
            vscode.commands.executeCommand("setContext", "file-browser.inSearchMode", false);
            
            // Clear any input
            this.current.value = "";
            
            // Set the starting point for visual selection
            if (this.current.activeItems.length > 0) {
                const activeItem = this.current.activeItems[0];
                this.visualSelectionStart = this.current.items.indexOf(activeItem);
                this.selectedItems = [activeItem];
                this.current.placeholder = "VISUAL mode (ESC to exit, j/k to select, r to rename, d to delete)";
            } else {
                // Can't enter visual mode without an active item
                this.inVisualMode = false;
                return;
            }
        } else {
            // Clear visual selection
            this.visualSelectionStart = -1;
            this.selectedItems = [];
            if (!this.inSearchMode && !this.inRenameMode && !this.inCreateMode) {
                this.current.placeholder = "NORMAL mode (h,j,k,l to navigate | i for search | r to rename | d to delete | c for new file)";
            }
        }
        
        // Update the UI to show selection
        this.updateVisualSelection();
    }

    toggleVisualMode() {
        this.setVisualMode(!this.inVisualMode);
    }

    exitVisualMode() {
        this.setVisualMode(false);
        // Prevent the tool from closing by stopping event propagation
        this.current.show();
    }

    updateVisualSelection() {
        if (!this.inVisualMode || this.visualSelectionStart < 0) {
            return;
        }
        
        const items = this.current.items;
        if (items.length === 0) {
            return;
        }
        
        let currentIndex = -1;
        if (this.current.activeItems.length > 0) {
            currentIndex = items.indexOf(this.current.activeItems[0]);
        }
        
        if (currentIndex < 0) {
            return;
        }
        
        // Calculate the range of items to select
        const start = Math.min(this.visualSelectionStart, currentIndex);
        const end = Math.max(this.visualSelectionStart, currentIndex);
        
        // Select all items in the range
        this.selectedItems = items.slice(start, end + 1);
        
        // Highlight the selected items
        // Unfortunately QuickPick doesn't support multiple selection highlighting natively
        // So we're updating the UI to indicate our selection
        for (const item of items) {
            if (this.selectedItems.includes(item)) {
                item.label = item.label.startsWith('$(check) ') ? 
                    item.label : 
                    '$(check) ' + item.label.replace(/^\$\(check\) /, '');
            } else {
                item.label = item.label.replace(/^\$\(check\) /, '');
            }
        }
        
        // Refresh the display
        this.current.items = [...items];
    }

    moveDown() {
        if (this.inActions || this.inSearchMode) {
            return;
        }

        const items = this.current.items;
        if (items.length === 0) {
            return;
        }

        let index = -1;
        if (this.current.activeItems.length > 0) {
            index = items.indexOf(this.current.activeItems[0]);
        }

        index = (index + 1) % items.length;
        this.current.activeItems = [items[index]];
        
        // Update visual selection if in visual mode
        if (this.inVisualMode) {
            this.updateVisualSelection();
        }
    }

    moveUp() {
        if (this.inActions || this.inSearchMode) {
            return;
        }

        const items = this.current.items;
        if (items.length === 0) {
            return;
        }

        let index = 0;
        if (this.current.activeItems.length > 0) {
            index = items.indexOf(this.current.activeItems[0]);
        }

        index = (index - 1 + items.length) % items.length;
        this.current.activeItems = [items[index]];
        
        // Update visual selection if in visual mode
        if (this.inVisualMode) {
            this.updateVisualSelection();
        }
    }

    // Add new methods for renaming and deleting in visual mode
    async renameInVisualMode() {
        if (!this.inVisualMode || this.selectedItems.length !== 1) {
            // Only allow renaming one item at a time
            return;
        }

        const item = this.selectedItems[0];
        if (!item.fileType) {
            // Can't rename special items like "New file"
            return;
        }

        // Enter rename mode but keep visual mode active
        this.inRenameMode = true;
        vscode.commands.executeCommand("setContext", "file-browser.inRenameMode", true);
        
        // Store the item we're renaming for later
        this.file = Some(item.name);
        
        // Set the input value to the current file name for editing
        this.current.value = item.name;
        this.current.placeholder = "Enter new name (Enter to confirm, ESC to cancel)";
        
        // Focus the input field and select the text for easy editing
        this.current.show();
    }

    async deleteInVisualMode() {
        if (!this.inVisualMode || this.selectedItems.length === 0) {
            return;
        }

        // Exit visual mode but keep the selected items
        const itemsToDelete = [...this.selectedItems];
        this.setVisualMode(false);

        // Only process items with fileType (actual files or directories)
        const validItems = itemsToDelete.filter(item => item.fileType !== undefined);
        
        if (validItems.length === 0) {
            return;
        }

        this.keepAlive = true;
        this.hide();

        // Create confirm message
        const itemNames = validItems.map(item => item.name).join('", "');
        const isMultiple = validItems.length > 1;
        const itemType = isMultiple ? "items" : 
            ((validItems[0].fileType! & FileType.Directory) === FileType.Directory ? "folder" : "file");
        
        const goAhead = `$(trash) Delete ${isMultiple ? 'these' : 'the'} ${itemType} "${itemNames}"`;
        const result = await vscode.window.showQuickPick(["$(close) Cancel", goAhead], {});
        
        if (result === goAhead) {
            // Delete each item one by one
            for (const item of validItems) {
                const itemPath = this.path.append(item.name);
                const isDir = (item.fileType! & FileType.Directory) === FileType.Directory;
                
                const delOp = await Result.await(
                    vscode.workspace.fs.delete(itemPath.uri, { recursive: isDir })
                );
                
                if (delOp.isErr()) {
                    vscode.window.showErrorMessage(
                        `Failed to delete ${isDir ? 'folder' : 'file'} "${item.name}"`
                    );
                }
            }
        }
        
        this.show();
        this.keepAlive = false;
        this.update();
    }

    async createNewFile() {
        // Exit any other modes
        this.inVisualMode = false;
        this.inSearchMode = false;
        this.inRenameMode = false;
        
        // Enter create mode
        this.inCreateMode = true;
        vscode.commands.executeCommand("setContext", "file-browser.inCreateMode", true);
        
        // Clear current selection and input
        this.current.value = "";
        this.current.placeholder = "Enter new file name (ESC to cancel)";
        
        // Focus the input field
        this.current.show();
    }

    exitRenameMode() {
        this.inRenameMode = false;
        vscode.commands.executeCommand("setContext", "file-browser.inRenameMode", false);
        this.current.value = "";
        this.current.placeholder = "NORMAL mode (h,j,k,l to navigate | i for search | r to rename | d to delete | c for new file)";
        // Prevent the tool from closing by stopping event propagation
        this.current.show();
    }

    exitCreateMode() {
        this.inCreateMode = false;
        vscode.commands.executeCommand("setContext", "file-browser.inCreateMode", false);
        this.current.value = "";
        this.current.placeholder = "NORMAL mode (h,j,k,l to navigate | i for search | r to rename | d to delete | c for new file)";
        // Prevent the tool from closing by stopping event propagation
        this.current.show();
    }

    // Rename file in normal mode
    async renameFile() {
        if (this.inVisualMode || this.inSearchMode || this.inRenameMode || this.inCreateMode) {
            return;
        }
        
        // Make sure we have an active item
        if (this.current.activeItems.length !== 1) {
            return;
        }
        
        const item = this.current.activeItems[0];
        if (!item.fileType) {
            // Can't rename special items like "New file"
            return;
        }
        
        // Enter rename mode
        this.inRenameMode = true;
        vscode.commands.executeCommand("setContext", "file-browser.inRenameMode", true);
        
        // Store the item we're renaming for later
        this.file = Some(item.name);
        
        // Set the input value to the current file name for editing
        this.current.value = item.name;
        this.current.placeholder = "Enter new name (Enter to confirm, ESC to cancel)";
        
        // Focus the input field and select the text for easy editing
        this.current.show();
    }
    
    // Delete file in normal mode
    async deleteFile() {
        if (this.inVisualMode || this.inSearchMode || this.inRenameMode || this.inCreateMode) {
            return;
        }
        
        // Make sure we have an active item
        if (this.current.activeItems.length !== 1) {
            return;
        }
        
        const item = this.current.activeItems[0];
        if (!item.fileType) {
            // Can't delete special items like "New file"
            return;
        }
        
        this.keepAlive = true;
        this.hide();
        
        // Confirm delete
        const isDir = (item.fileType & FileType.Directory) === FileType.Directory;
        const itemType = isDir ? "folder" : "file";
        
        const goAhead = `$(trash) Delete the ${itemType} "${item.name}"`;
        const result = await vscode.window.showQuickPick(["$(close) Cancel", goAhead], {});
        
        if (result === goAhead) {
            const itemPath = this.path.append(item.name);
            
            const delOp = await Result.await(
                vscode.workspace.fs.delete(itemPath.uri, { recursive: isDir })
            );
            
            if (delOp.isErr()) {
                vscode.window.showErrorMessage(
                    `Failed to delete ${itemType} "${item.name}"`
                );
            }
        }
        
        this.show();
        this.keepAlive = false;
        this.update();
    }
}

export function activate(context: vscode.ExtensionContext) {
    setContext(false);
    vscode.commands.executeCommand("setContext", "file-browser.inSearchMode", false);
    vscode.commands.executeCommand("setContext", "file-browser.inVisualMode", false);
    vscode.commands.executeCommand("setContext", "file-browser.inRenameMode", false);
    vscode.commands.executeCommand("setContext", "file-browser.inCreateMode", false);
    vscode.commands.executeCommand("setContext", "inFileBrowserEscapeHandler", false);

    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.open", () => {
            const document = vscode.window.activeTextEditor?.document;
            const workspaceFolder =
                vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            let path = new Path(workspaceFolder?.uri || Uri.file(OS.homedir()));
            let file: Option<string> = None;
            if (document && !document.isUntitled) {
                path = new Path(document.uri);
                file = path.pop();
            }
            active = Some(new FileBrowser(path, file));
            setContext(true);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.rename", () =>
            active
                .chainNone(() => {
                    const document = vscode.window.activeTextEditor?.document;
                    const workspaceFolder =
                        vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
                    const path = new Path(
                        document?.uri || workspaceFolder?.uri || Uri.file(OS.homedir())
                    );
                    active = Some(new FileBrowser(path, None));
                    setContext(true);
                    return active;
                })
                .ifSome((active) => active.rename())
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.stepIn", () =>
            active.ifSome((active) => active.stepIn())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.stepOut", () =>
            active.ifSome((active) => active.stepOut())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.actions", () =>
            active.ifSome((active) => active.actions())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.tabNext", () =>
            active.ifSome((active) => active.tabCompletion(true))
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.tabPrev", () =>
            active.ifSome((active) => active.tabCompletion(false))
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.moveDown", () =>
            active.ifSome((active) => active.moveDown())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.moveUp", () =>
            active.ifSome((active) => active.moveUp())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.toggleSearchMode", () =>
            active.ifSome((active) => active.toggleSearchMode())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.exitSearchMode", () =>
            active.ifSome((active) => active.exitSearchMode())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.toggleVisualMode", () =>
            active.ifSome((active) => active.toggleVisualMode())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.exitVisualMode", () =>
            active.ifSome((active) => active.exitVisualMode())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.renameInVisualMode", () =>
            active.ifSome((active) => active.renameInVisualMode())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.deleteInVisualMode", () =>
            active.ifSome((active) => active.deleteInVisualMode())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.createNewFile", () =>
            active.ifSome((active) => active.createNewFile())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.exitRenameMode", () =>
            active.ifSome((active) => active.exitRenameMode())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.exitCreateMode", () =>
            active.ifSome((active) => active.exitCreateMode())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.renameFile", () =>
            active.ifSome((active) => active.renameFile())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.deleteFile", () =>
            active.ifSome((active) => active.deleteFile())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.handleEscapeKey", () => {
            return active.match(
                (active) => {
                    // Handle escape key based on current mode
                    if (active.inSearchMode) {
                        active.exitSearchMode();
                        return true;
                    } else if (active.inVisualMode) {
                        active.exitVisualMode();
                        return true;
                    } else if (active.inRenameMode) {
                        active.exitRenameMode();
                        return true;
                    } else if (active.inCreateMode) {
                        active.exitCreateMode();
                        return true;
                    }
                    return false;
                },
                () => false
            );
        })
    );
}

export function deactivate() {}
