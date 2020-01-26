import { Uri, workspace } from "vscode";

export class ConfigAccessor {
    constructor() {
        /**/
    }

    private getConfigItem<T>(item: string): T | undefined {
        return workspace.getConfiguration("perforce").get<T>(item);
    }

    public get changelistOrder(): string {
        return this.getConfigItem("changelistOrder") ?? "descending";
    }

    public get ignoredChangelistPrefix(): string | undefined {
        return this.getConfigItem("ignoredChangelistPrefix");
    }

    public get hideNonWorkspaceFiles(): boolean {
        return this.getConfigItem("hideNonWorkspaceFiles");
    }

    public get hideShelvedFiles(): boolean {
        return this.getConfigItem("hideShelvedFiles");
    }

    public get maxFilePerCommand(): number {
        return this.getConfigItem("maxFilePerCommand");
    }
}

export class WorkspaceConfigAccessor extends ConfigAccessor {
    constructor(private _workspaceUri: Uri) {
        super();
    }

    private getWorkspaceConfigItem<T>(item: string): T | undefined {
        return workspace.getConfiguration("perforce", this._workspaceUri).get<T>(item);
    }

    public get dir(): string {
        return this.getWorkspaceConfigItem("dir");
    }
}
