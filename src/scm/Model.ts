import { PerforceService, IPerforceConfig } from "./../PerforceService";
import {
    Uri,
    EventEmitter,
    Event,
    SourceControl,
    SourceControlResourceGroup,
    Disposable,
    ProgressLocation,
    window,
    workspace,
    commands
} from "vscode";
import { Utils } from "../Utils";
import { Display } from "../Display";
import { Resource } from "./Resource";

import * as Path from "path";
import * as vscode from "vscode";

function isResourceGroup(arg: any): arg is SourceControlResourceGroup {
    return arg.id !== undefined;
}

type ChangeInfo = { chnum: number; description: string };
type ShelvedFileInfo = { chnum: number; action: string; path: string };

export class Model implements Disposable {
    private _disposables: Disposable[] = [];

    private _onDidChange = new EventEmitter<void>();
    public get onDidChange(): Event<void> {
        return this._onDidChange.event;
    }

    public dispose() {
        if (this._disposables) {
            this._disposables.forEach(d => d.dispose());
            this._disposables = [];
        }
    }

    public _sourceControl: SourceControl;
    private _infos = new Map<string, string>();

    private _defaultGroup: SourceControlResourceGroup;
    private _pendingGroups = new Map<
        number,
        { description: string; group: SourceControlResourceGroup }
    >();
    private _compatibilityMode: string;
    private _workspaceUri: Uri;
    private _config: IPerforceConfig;

    get workspaceUri() {
        return this._workspaceUri;
    }

    public get ResourceGroups(): SourceControlResourceGroup[] {
        const result: SourceControlResourceGroup[] = [];

        if (this._defaultGroup) {
            result.push(this._defaultGroup);
        }

        this._pendingGroups.forEach(value => {
            const config = workspace.getConfiguration("perforce");
            if (
                config.get<boolean>("hideEmptyChangelists") &&
                value.group.resourceStates.length == 0
            ) {
                value.group.dispose();
            } else {
                result.push(value.group);
            }
        });

        return result;
    }

    public constructor(
        config: IPerforceConfig,
        workspaceUri: Uri,
        compatibilityMode: string
    ) {
        this._config = config;
        this._workspaceUri = workspaceUri;
        this._compatibilityMode = compatibilityMode;
    }

    public async Sync(): Promise<void> {
        const loggedin = await Utils.isLoggedIn(
            this._workspaceUri,
            this._compatibilityMode
        );
        if (!loggedin) {
            return;
        }

        window.withProgress(
            {
                location: ProgressLocation.SourceControl,
                title: "Syncing..."
            },
            () => this.syncUpdate()
        );
    }

    public async Refresh(): Promise<void> {
        this.clean();
        const loggedin = await Utils.isLoggedIn(
            this._workspaceUri,
            this._compatibilityMode
        );
        if (!loggedin) {
            return;
        }

        await window.withProgress(
            {
                location: ProgressLocation.SourceControl,
                title: "Updating info..."
            },
            () => this.updateInfo()
        );
        await window.withProgress(
            {
                location: ProgressLocation.SourceControl,
                title: "Updating status..."
            },
            () => this.updateStatus()
        );
    }

    public async Info(): Promise<void> {
        const resource = this._sourceControl.rootUri;
        Display.channel.show();
        await PerforceService.executeAsPromise(
            resource,
            "info",
            PerforceService.handleInfoServiceResponse.bind(this)
        );
    }

    public async SaveToChangelist(
        descStr: string,
        existingChangelist?: string
    ): Promise<string> {
        const config = workspace.getConfiguration("perforce");
        const hideNonWorksSpaceFiles = config.get<boolean>("hideNonWorkspaceFiles");

        const args = `-o ${existingChangelist ? existingChangelist : ""}`;
        if (!descStr) {
            descStr = "<saved by VSCode>";
        }

        const spec: string = await Utils.runCommand(
            this._workspaceUri,
            "change",
            null,
            null,
            args
        );
        const changeFields = spec.trim().split(/\n\r?\n/);
        let newSpec = "";
        for (const field of changeFields) {
            if (hideNonWorksSpaceFiles && field.startsWith("Files:")) {
                newSpec += "Files:\n\t";
                const fileListStr = field.substring(8); // remove prefix Files:\n\t

                const depotFiles = fileListStr.split("\n").map(file => {
                    const endOfFileStr = file.indexOf("#");
                    return file.substring(0, endOfFileStr).trim();
                });

                const fstatInfo = await this.getFstatInfoForFiles(depotFiles);

                newSpec += fstatInfo
                    .filter(info => {
                        const uri = Uri.file(info["clientFile"]);
                        const workspaceFolder = workspace.getWorkspaceFolder(uri);
                        return !!workspaceFolder;
                    })
                    .map(info => {
                        return info["depotFile"] + "\t# " + info["action"];
                    })
                    .join("\n\t");
                newSpec += "\n\n";
            } else if (field.startsWith("Description:")) {
                newSpec += "Description:\n\t";
                newSpec += descStr
                    .trim()
                    .split("\n")
                    .join("\n\t");
                newSpec += "\n\n";
            } else {
                newSpec += field;
                newSpec += "\n\n";
            }
        }

        let newChangelistNumber;
        try {
            const createdStr = await Utils.runCommand(
                this._workspaceUri,
                "change",
                null,
                null,
                "-i",
                null,
                newSpec
            );
            // Change #### created with ...
            const matches = new RegExp(/Change\s(\d+)\screated with/).exec(createdStr);
            if (matches) {
                newChangelistNumber = matches[1];
            }
            Display.channel.append(createdStr);
            this.Refresh();
        } catch (err) {
            Display.showError(err.toString());
        }

        return newChangelistNumber;
    }

    public async ProcessChangelist(): Promise<void> {
        let description = this._sourceControl.inputBox.value;
        this._sourceControl.inputBox.value = "";

        let existingChangelist = "";
        const matches = new RegExp(/^#(\d+)\r?\n([^]+)/).exec(description);
        if (matches) {
            existingChangelist = matches[1];
            description = matches[2];
        }

        await this.SaveToChangelist(description, existingChangelist);
    }

    public async EditChangelist(input: SourceControlResourceGroup): Promise<void> {
        let descStr = "";
        const id = input.id;
        let args = "-o ";
        if (id.startsWith("pending")) {
            const chnum = id.substr(id.indexOf(":") + 1);
            descStr = `#${chnum}\n`;
            args += chnum;
        }

        const output: string = await Utils.runCommand(
            this._workspaceUri,
            "change",
            null,
            null,
            args
        );
        const changeFields = output.trim().split(/\n\r?\n/);
        for (const field of changeFields) {
            if (field.startsWith("Description:")) {
                descStr += field
                    .substr(field.indexOf("\n"))
                    .replace(/\n\t/g, "\n")
                    .trim();
                break;
            }
        }

        this._sourceControl.inputBox.value = descStr;
    }

    public async Describe(input: SourceControlResourceGroup): Promise<void> {
        const id = input.id;

        if (id.startsWith("default")) {
            const command = "change";
            const args = "-o";
            const uri: Uri = Uri.parse("perforce:").with({
                query: Utils.makePerforceUriQuery(command, args)
            });
            await commands.executeCommand<void>("vscode.open", uri);
        } else if (id.startsWith("pending")) {
            const command = "describe";
            const args = id.substr(id.indexOf(":") + 1);

            const uri: Uri = Uri.parse("perforce:").with({
                query: Utils.makePerforceUriQuery(command, args)
            });
            await commands.executeCommand<void>("vscode.open", uri);
        }
    }

    public async SubmitDefault(): Promise<void> {
        const config = workspace.getConfiguration("perforce");
        const hideNonWorksSpaceFiles = config.get<boolean>("hideNonWorkspaceFiles");

        const loggedin = await Utils.isLoggedIn(
            this._workspaceUri,
            this._compatibilityMode
        );
        if (!loggedin) {
            return;
        }

        const noFiles = "File(s) not opened on this client.";
        let fileListStr;
        try {
            fileListStr = await Utils.runCommand(
                this._workspaceUri,
                "opened",
                null,
                null,
                "-c default"
            );
            if (fileListStr === noFiles) {
                Display.showError(noFiles);
                return;
            }
        } catch (err) {
            Display.showError(err.toString());
            return;
        }

        const descStr = await vscode.window.showInputBox({
            placeHolder: "New changelist description",
            validateInput: (value: string) => {
                if (!value || value.trim().length === 0) {
                    return "Cannot set empty description";
                }
                return null;
            },
            ignoreFocusOut: true
        });

        if (descStr === undefined || descStr.trim().length == 0) {
            // pressing enter with no other input will still submit the empty string
            Display.showError("Cannot set empty description");
            return;
        }

        const pick = await vscode.window.showQuickPick(
            ["Submit", "Save Changelist", "Cancel"],
            {
                ignoreFocusOut: true
            }
        );

        if (!pick || pick == "Cancel") {
            return;
        }

        if (pick === "Submit") {
            if (hideNonWorksSpaceFiles) {
                const changeListNr = await this.SaveToChangelist(descStr);
                this.Submit(parseInt(changeListNr, 10));
            } else {
                this.Submit(descStr);
            }
            return;
        }

        this.SaveToChangelist(descStr);
    }

    public async Submit(
        input: SourceControlResourceGroup | string | number
    ): Promise<void> {
        const command = "submit";
        let args = "";

        if (typeof input === "string") {
            args = `-d "${input}"`;
        } else if (typeof input == "number") {
            args = `-c ${input}`;
        } else {
            const group = input;
            const id = group.id;
            if (id) {
                const chnum = id.substr(id.indexOf(":") + 1);
                if (id.startsWith("pending")) {
                    args = "-c " + chnum;
                } else if (id.startsWith("shelved")) {
                    args = "-e " + chnum;
                } else {
                    return;
                }
            } else {
                return;
            }
        }

        await Utils.runCommand(this._workspaceUri, command, null, null, args)
            .then(output => {
                Display.channel.append(output);
                Display.showMessage("Changelist Submitted");
                this.Refresh();
            })
            .catch(reason => {
                Display.showError(reason.toString());
            });
    }

    public async Revert(
        input: Resource | SourceControlResourceGroup,
        unchanged?: boolean
    ): Promise<void> {
        const command = "revert";
        let file = null;
        let args = unchanged ? "-a " : "";
        let needRefresh = false;

        let message = "Are you sure you want to revert the changes ";
        if (input instanceof Resource) {
            file = Uri.file(input.resourceUri.fsPath);
            message += "to file " + Path.basename(input.resourceUri.fsPath) + "?";
        } else if (isResourceGroup(input)) {
            const id = input.id;
            if (id.startsWith("default")) {
                args += "-c default //...";
                message += "in the default changelist?";
            } else if (id.startsWith("pending")) {
                const chnum = id.substr(id.indexOf(":") + 1);
                args += "-c " + chnum + " //...";
                message += "in the changelist " + chnum + "?";
            } else {
                return;
            }
        } else {
            return;
        }

        if (!unchanged) {
            const yes = "Revert Changes";
            const pick = await window.showWarningMessage(message, { modal: true }, yes);
            if (pick !== yes) {
                return;
            }
        }

        await Utils.runCommand(this._workspaceUri, command, file, null, args)
            .then(output => {
                Display.updateEditor();
                Display.channel.append(output);
                needRefresh = true;
            })
            .catch(reason => {
                Display.showError(reason.toString());
            });

        // delete changelist after
        if (isResourceGroup(input)) {
            const command = "change";
            const id = input.id;
            const chnum = id.substr(id.indexOf(":") + 1);
            if (id.startsWith("pending")) {
                args = "-d " + chnum;

                await Utils.runCommand(this._workspaceUri, command, null, null, args)
                    .then(output => {
                        Display.updateEditor();
                        Display.channel.append(output);
                        needRefresh = true;
                    })
                    .catch(reason => {
                        Display.showError(reason.toString());
                    });
            }
        }

        if (needRefresh) {
            this.Refresh();
        }
    }

    public async QuietlyRevertChangelist(chnum: string): Promise<void> {
        const command = "revert";
        const args = "-c " + chnum + " //...";

        const output = await Utils.runCommand(
            this._workspaceUri,
            command,
            null,
            null,
            args
        );
        Display.updateEditor();
        Display.channel.append(output);
    }

    public async ShelveChangelist(
        input: SourceControlResourceGroup,
        revert?: boolean
    ): Promise<void> {
        const id = input.id;
        const chnum = id.substr(id.indexOf(":") + 1);

        if (chnum === "default") {
            throw new Error("Cannot shelve the default changelist");
        }

        const command = "shelve";
        const args = "-f -c " + chnum;

        try {
            await Utils.runCommand(this._workspaceUri, command, null, null, args);
            if (revert) {
                await this.QuietlyRevertChangelist(chnum);
            }
            Display.showMessage("Changelist shelved");
        } catch (err) {
            Display.showImportantError(err.toString());
        }
        this.Refresh();
    }

    public async UnshelveChangelist(input: SourceControlResourceGroup): Promise<void> {
        const id = input.id;
        const chnum = id.substr(id.indexOf(":") + 1);

        if (chnum === "default") {
            throw new Error("Cannot unshelve the default changelist");
        }

        const command = "unshelve";
        const args = "-f -s " + chnum + " -c " + chnum;

        try {
            await Utils.runCommand(this._workspaceUri, command, null, null, args);
            this.Refresh();
            Display.showMessage("Changelist unshelved");
        } catch (err) {
            Display.showImportantError(err.toString());
        }
    }

    public async DeleteShelvedChangelist(
        input: SourceControlResourceGroup
    ): Promise<void> {
        const id = input.id;
        const chnum = id.substr(id.indexOf(":") + 1);

        if (chnum === "default") {
            throw new Error("Cannot delete shelved files from the default changelist");
        }

        const message =
            "Are you sure you want to delete the shelved files from changelist " +
            chnum +
            "?";

        const yes = "Delete Shelved Files";
        const pick = await window.showWarningMessage(message, { modal: true }, yes);
        if (pick !== yes) {
            return;
        }

        const command = "shelve";
        const args = "-d -c " + chnum;

        try {
            await Utils.runCommand(this._workspaceUri, command, null, null, args);
            this.Refresh();
            Display.showMessage("Shelved files deleted");
        } catch (err) {
            Display.showImportantError(err.toString());
        }
    }

    public async ShelveOrUnshelve(input: Resource): Promise<void> {
        if (input.isShelved) {
            const args = "-c " + input.change + " -s " + input.change;
            const command = "unshelve";
            await Utils.runCommand(
                this._workspaceUri,
                command,
                input.depotPath,
                null,
                args
            )
                .then(() => {
                    const args = "-d -c " + input.change;
                    Utils.runCommand(
                        this._workspaceUri,
                        "shelve",
                        input.depotPath,
                        null,
                        args
                    )
                        .then(output => {
                            Display.updateEditor();
                            Display.channel.append(output);

                            this.Refresh();
                        })
                        .catch(reason => {
                            Display.showImportantError(reason.toString());

                            this.Refresh();
                        });
                })
                .catch(reason => {
                    Display.showImportantError(reason.toString());
                });
        } else {
            const args = "-f -c " + input.change;
            const command = "shelve";
            await Utils.runCommand(
                this._workspaceUri,
                command,
                input.resourceUri,
                null,
                args
            )
                .then(() => {
                    this.Revert(input);
                })
                .catch(reason => {
                    Display.showImportantError(reason.toString());
                });
        }
    }

    public async ReopenFile(resources: Resource[]): Promise<void> {
        const loggedin = await Utils.isLoggedIn(
            this._workspaceUri,
            this._compatibilityMode
        );
        if (!loggedin) {
            return;
        }

        //TODO: remove the file current changelist
        const items = [];
        items.push({ id: "default", label: this._defaultGroup.label, description: "" });
        this._pendingGroups.forEach((value, key) => {
            items.push({
                id: key.toString(),
                label: "#" + key.toString(),
                description: value.description
            });
        });

        window
            .showQuickPick(items, {
                matchOnDescription: true,
                placeHolder: "Choose a changelist:"
            })
            .then(selection => {
                if (selection == undefined) {
                    Display.showMessage("operation cancelled");
                    return;
                }

                for (const resource of resources) {
                    const file = Uri.file(resource.resourceUri.fsPath);
                    const args = "-c " + selection.id;

                    Utils.runCommand(this._workspaceUri, "reopen", file, null, args)
                        .then(output => {
                            Display.channel.append(output);
                            this.Refresh();
                        })
                        .catch(reason => {
                            Display.showImportantError(reason.toString());
                        });
                }
            });
    }

    private clean() {
        if (this._defaultGroup) {
            this._defaultGroup.dispose();
            this._defaultGroup = null;
        }

        this._pendingGroups.forEach(value => value.group.dispose());
        this._pendingGroups.clear();

        this._onDidChange.fire();
    }

    private async syncUpdate(): Promise<void> {
        const trailingSlash = /^(.*)(\/)$/;
        const config = this._config;
        let pathToSync = null;
        let p4Dir = config.p4Dir
            ? config.p4Dir
            : vscode.workspace
                  .getConfiguration("perforce", this._workspaceUri)
                  .get<string>("dir");
        if (p4Dir && p4Dir !== "none") {
            p4Dir = Utils.normalize(p4Dir);
            if (!trailingSlash.exec(p4Dir)) {
                p4Dir += "/";
            }
            pathToSync = vscode.Uri.file(p4Dir + "...");
        }

        await Utils.runCommand(this._workspaceUri, "sync", pathToSync, null, "")
            .then(output => {
                Display.channel.append(output);
                this.Refresh();
            })
            .catch(reason => {
                Display.showImportantError(reason.toString());
            });
    }

    private async updateInfo(): Promise<void> {
        const resource = Uri.file(this._config.localDir);
        this._infos = Utils.processInfo(await Utils.getSimpleOutput(resource, "info"));
    }

    private getConfigItem<T>(item: string): T | undefined {
        return workspace.getConfiguration("perforce").get<T>(item);
    }

    private getChangelistOrder(): string {
        return this.getConfigItem("changelistOrder") ?? "descending";
    }

    private getIgnoredChangelistPrefix(): string | undefined {
        return this.getConfigItem("ignoredChangelistPrefix");
    }

    private hideNonWorkspaceFiles(): boolean {
        return this.getConfigItem("hideNonWorkspaceFiles");
    }

    private hideShelvedFiles(): boolean {
        return this.getConfigItem("hideNonWorkspaceFiles");
    }

    private cleanAllGroups() {
        this._pendingGroups.forEach(value => value.group.dispose());
        this._pendingGroups.clear();

        if (this._defaultGroup) {
            this._defaultGroup.dispose();
            this._defaultGroup = null;
        }
    }

    private async updateStatus(): Promise<void> {
        const loggedin = await Utils.isLoggedIn(
            this._workspaceUri,
            this._compatibilityMode
        );
        if (!loggedin) {
            return;
        }

        const defaults: Resource[] = [];
        const pendings = new Map<number, Resource[]>();

        const pendingArgs = "-c " + this._infos.get("Client name") + " -s pending";
        const output: string = await Utils.runCommand(
            this._workspaceUri,
            "changes",
            null,
            null,
            pendingArgs
        );
        let changelists = output.trim().split("\n");

        if (this.getChangelistOrder() === "ascending") {
            changelists = changelists.reverse();
        }

        const prefix = this.getIgnoredChangelistPrefix();

        let changeInfos = changelists
            .map(c => this.parseChangelistDescription(c))
            .filter(c => c !== undefined);

        const ignoredChangelists: number[] = changeInfos
            .filter(c => c.description.startsWith(prefix))
            .map(c => c.chnum);

        if (prefix) {
            changeInfos = changeInfos.filter(c => !c.description.startsWith(prefix));
        }

        const shelvedResourcePromises = this.hideShelvedFiles()
            ? []
            : this.getAllShelvedResources(changeInfos);
        const openResourcePromises = this.getDepotOpenedResources();
        const [shelvedResources, openResources] = await Promise.all([
            shelvedResourcePromises,
            openResourcePromises
        ]);

        const allResources = shelvedResources.concat(openResources);

        allResources.forEach(resource => {
            if (resource.change.startsWith("default")) {
                defaults.push(resource);
            } else {
                const chnum: number = parseInt(resource.change);

                if (!pendings.has(chnum)) {
                    pendings.set(chnum, []);
                }
                pendings.get(chnum).push(resource);
            }
        });

        // do this AFTER the async operations! Do not mutate `this` before this point
        // TODO actually refresh kills them straight away anyway - should it?
        this.cleanAllGroups();

        this._defaultGroup = this._sourceControl.createResourceGroup(
            "default",
            "Default Changelist"
        );
        this._defaultGroup["model"] = this;
        this._defaultGroup.resourceStates = defaults;

        const groups = changeInfos.map(c => {
            const group = this._sourceControl.createResourceGroup(
                "pending:" + c.chnum,
                "#" + c.chnum + ": " + c.description
            );
            group["model"] = this;
            group.resourceStates = [];
            return group;
        });

        groups.forEach((group, i) => {
            this._pendingGroups.set(changeInfos[i].chnum, {
                description: changeInfos[i].description,
                group: group
            });
        });

        pendings.forEach((value, key) => {
            const chnum = key.toString();
            if (this._pendingGroups.has(key)) {
                this._pendingGroups.get(key).group.resourceStates = value;
            } else if (!ignoredChangelists.includes(key)) {
                console.log("ERROR: pending changelist not found: " + chnum);
            }
        });

        this._onDidChange.fire();
    }

    private getResourceFromFileInfo(info) {
        const clientFile = info["clientFile"];
        const change = info["change"];
        const action = info["action"];
        const headType = info["headType"];
        const depotPath = Uri.file(info["depotFile"]);
        const fromFile = info["resolveFromFile0"]
            ? Uri.file(info["resolveFromFile0"])
            : undefined;
        const uri = Uri.file(clientFile);
        if (this.hideNonWorkspaceFiles()) {
            const workspaceFolder = workspace.getWorkspaceFolder(uri);
            if (!workspaceFolder) {
                return;
            }
        }
        const resource: Resource = new Resource(
            this,
            depotPath,
            uri,
            change,
            false,
            action,
            fromFile,
            headType
        );

        return resource;
    }

    private parseChangelistDescription(value: string): ChangeInfo | undefined {
        // Change num on date by user@client [status] description
        const matches = new RegExp(
            /Change\s(\d+)\son\s(.+)\sby\s(.+)@(.+)\s\*(.+)\*\s\'(.*)\'/
        ).exec(value);

        if (matches) {
            const num = matches[1];
            // const date = matches[2];
            // const user = matches[3];
            // const client = matches[4];
            // const status = matches[5];
            const description = matches[6];

            const chnum: number = parseInt(num.toString());
            return { chnum, description };
        }
    }

    private async getAllShelvedResources(changes: ChangeInfo[]): Promise<Resource[]> {
        const allFileInfo = await this.getDepotShelvedFilePaths(
            changes.map(c => c.chnum)
        );
        return this.getShelvedResources(allFileInfo);
    }

    private async getShelvedResources(files: ShelvedFileInfo[]): Promise<Resource[]> {
        const fstatInfo = await this.getFstatInfoForFiles(
            files.map(f => f.path),
            "-Or"
        );

        return fstatInfo.map((info, i) => {
            const { path, action, chnum } = files[i];

            let underlyingUri: Uri;
            let fromFile: Uri;
            if (info) {
                // not present if a file is shelved for add, and not in the filesystem
                underlyingUri = Uri.file(info["clientFile"]);
                fromFile = info["resolveFromFile0"]
                    ? Uri.file(info["resolveFromFile0"])
                    : undefined;
            }

            const resource: Resource = new Resource(
                this,
                Uri.file(path),
                underlyingUri,
                chnum.toString(),
                true,
                action,
                fromFile
            );
            return resource;
        });
    }

    private async getDepotOpenedResources(): Promise<Resource[]> {
        const depotOpenedFilePromises = this.getDepotOpenedFilePaths();
        const fstatInfo = await this.getFstatInfoForFiles(
            await depotOpenedFilePromises,
            "-Or"
        );
        return fstatInfo.map(info => this.getResourceFromFileInfo(info));
    }

    private async getDepotOpenedFilePaths(): Promise<string[]> {
        const resource = Uri.file(this._config.localDir);
        let opened = [];
        try {
            const output = await Utils.getSimpleOutput(resource, "opened");
            opened = output.trim().split("\n");
        } catch (err) {
            // perforce writes to stderr if no files are opened.
            console.log("ERROR: " + err);
        }

        const files = [];
        opened.forEach(open => {
            const matches = open.match(
                /(.+)#(\d+)\s-\s([\w\/]+)\s(default\schange|change\s\d+)\s\(([\w\+]+)\)/
            );
            if (matches) {
                files.push(matches[1]);
            }
        });

        return files;
    }

    private async getDepotShelvedFilePaths(chnums: number[]): Promise<ShelvedFileInfo[]> {
        if (chnums.length === 0) {
            return [];
        }
        const resource = Uri.file(this._config.localDir);
        const output = await Utils.getSimpleOutput(
            resource,
            "describe -Ss " + chnums.join(" ")
        );
        const shelved = output.trim().split("\n");
        if (shelved.length === 0) {
            return [];
        }

        const files = [];
        let curCh: number = 0;
        shelved.forEach(open => {
            const chMatch = new RegExp(/^Change (\d+) by/).exec(open);
            if (chMatch) {
                curCh = parseInt(chMatch[1]);
            } else {
                const matches = new RegExp(/(\.+)\ (.*)#(.*) (.*)/).exec(open);
                if (matches) {
                    files.push({
                        chnum: curCh,
                        path: matches[2],
                        action: matches[4].trim()
                    });
                }
            }
        });

        return files;
    }

    private splitArray<T>(arr: T[], chunkSize: number): T[][] {
        const ret: T[][] = [];
        for (let i = 0; i < arr.length; i += chunkSize) {
            ret.push(arr.slice(i, i + chunkSize));
        }
        return ret;
    }

    private async getFstatInfoForFiles(
        files: string[],
        additionalParams?: string
    ): Promise<{}[]> {
        const config = workspace.getConfiguration("perforce");
        const maxFilePerCommand: number = config.get<number>("maxFilePerCommand");

        const promises = this.splitArray(files, maxFilePerCommand).map(fs =>
            this.getFstatInfoForChunk(fs, additionalParams)
        );

        const result = await Promise.all(promises);

        return result.reduce((prev, cur) => prev.concat(cur), []);
    }

    private async getFstatInfoForChunk(
        files: string[],
        additionalParams?: string
    ): Promise<{}[]> {
        const resource = Uri.file(this._config.localDir);

        if (additionalParams === undefined) {
            additionalParams = "";
        }

        // a shelved file may write to stderr if it doesn't exist in the workspace - so don't complain for stderr
        const [fstatOutput] = await Utils.getOutputs(
            resource,
            `fstat ${additionalParams} "${files.join('" "')}"`
        );

        // Windows will have lines end with \r\n.
        // Each file has multiple lines of output separated by a blank line.
        // Splitting on \n\r?\n will find newlines followed immediately by a newline
        // which will split the output for each file.
        const fstatFiles = fstatOutput.trim().split(/\n\r?\n/);
        const all = fstatFiles.map(file => {
            const lines = file.split("\n");
            const lineMap = {};
            lines.forEach(line => {
                // ... Key Value
                const matches = new RegExp(/[.]{3} (\w+)[ ]*(.+)?/).exec(line);
                if (matches) {
                    // A key may not have a value (e.g. `isMapped`).
                    // Treat these as flags and map them to 'true'.
                    lineMap[matches[1]] = matches[2] ? matches[2] : "true";
                }
            });
            return lineMap;
        });

        // there may be gaps due to missing shelved files - map to the correct positions
        return files.map(file => all.find(fs => fs["depotFile"] === file));
    }
}
