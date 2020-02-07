import { window, workspace, Uri, Disposable, Event, EventEmitter } from "vscode";
import { Utils } from "./Utils";
import { Display } from "./Display";

export class PerforceContentProvider {
    private onDidChangeEmitter = new EventEmitter<Uri>();
    get onDidChange(): Event<Uri> {
        return this.onDidChangeEmitter.event;
    }

    private disposables: Disposable[] = [];
    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }

    constructor() {
        this.disposables.push(
            workspace.registerTextDocumentContentProvider("perforce", this)
        );
    }

    public provideTextDocumentContent(uri: Uri): Promise<string> {
        return new Promise<string>(resolve => {
            if (uri.path === "EMPTY") {
                resolve("");
                return;
            }

            let revision: string = uri.fragment;
            if (revision && !revision.startsWith("@")) {
                revision = "#" + uri.fragment;
            }

            const allArgs = Utils.decodeUriQuery(uri.query ?? "");

            const args = (allArgs["p4args"] as string) ?? "-q";
            const command = (allArgs["command"] as string) ?? "print";

            if (allArgs["depot"]) {
                const resource =
                    allArgs["workspace"] && typeof (allArgs["workspace"] === "string")
                        ? Uri.file(allArgs["workspace"] as string)
                        : workspace.workspaceFolders?.[0].uri;
                if (!resource) {
                    throw new Error("A resource is required");
                }
                Utils.runCommand(
                    resource,
                    command,
                    Utils.getDepotPathFromDepotUri(uri),
                    revision,
                    args
                ).then(resolve);
                return;
            }

            const file = uri.fsPath ? Uri.file(uri.fsPath) : null;

            if (!file) {
                // Try to guess the proper workspace to use
                if (
                    window.activeTextEditor &&
                    !window.activeTextEditor.document.isUntitled
                ) {
                    Utils.runCommand(
                        window.activeTextEditor.document.uri,
                        command,
                        null,
                        revision,
                        args
                    ).then(resolve);
                } else if (workspace.workspaceFolders) {
                    const resource = workspace.workspaceFolders[0].uri;
                    Utils.runCommand(resource, command, null, revision, args).then(
                        resolve
                    );
                } else {
                    throw new Error(
                        `Can't find proper workspace for command ${command} `
                    );
                }
            } else {
                Utils.runCommandForFile(command, file, revision, args).then(resolve);
            }
        }).catch(reason => {
            Display.showError(reason.toString());
            return "";
        });
    }
}
