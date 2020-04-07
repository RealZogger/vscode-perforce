"use strict";

import { PerforceCommands } from "./PerforceCommands";
import { PerforceContentProvider } from "./ContentProvider";
import FileSystemActions from "./FileSystemActions";
import { PerforceSCMProvider } from "./ScmProvider";
import { PerforceService } from "./PerforceService";
import { Display } from "./Display";
import { Utils } from "./Utils";
import * as vscode from "vscode";
import * as Path from "path";

import { Disposable } from "vscode";
import { WorkspaceConfigAccessor } from "./ConfigService";
import { AnnotationProvider } from "./annotations/AnnotationProvider";
import * as ContextVars from "./ContextVars";
import * as QuickPicks from "./quickPick/QuickPicks";
import * as p4 from "./api/PerforceApi";
import { isTruthy } from "./TsUtils";

let _isRegistered = false;
const _disposable: vscode.Disposable[] = [];
let _perforceContentProvider: PerforceContentProvider | undefined;

function logInitProgress(uri: vscode.Uri, message: string) {
    Display.channel.appendLine("> " + uri + ": " + message);
}

export type ClientRoot = {
    configSource: vscode.Uri;
    clientRoot: vscode.Uri;
    clientName: string;
    userName: string;
    serverAddress: string;
    isInRoot: boolean;
    isAboveRoot?: boolean;
};

async function findClientRoot(uri: vscode.Uri): Promise<ClientRoot | undefined> {
    try {
        const info = await p4.getInfo(uri, {});
        const rootStr = info.get("Client root");
        if (rootStr) {
            const clientName = info.get("Client name") ?? "unknown";
            const serverAddress = info.get("Server address") ?? "";
            const userName = info.get("User name") ?? "";
            const isInRoot = isInClientRoot(uri, Utils.normalize(rootStr));
            const isAboveRoot = isClientRootIn(uri, Utils.normalize(rootStr));
            return {
                configSource: uri,
                clientRoot: vscode.Uri.file(rootStr),
                clientName,
                userName,
                serverAddress,
                isInRoot,
                isAboveRoot,
            };
        }
    } catch (err) {}
    return undefined;
}

function isInClientRoot(testFile: vscode.Uri, rootFsPath: string) {
    const wksRootN = Utils.normalize(testFile.fsPath);
    return wksRootN.startsWith(rootFsPath);
}

function isClientRootIn(workspace: vscode.Uri, rootFsPath: string) {
    const wksRootN = Utils.normalize(workspace.fsPath);
    return rootFsPath.startsWith(wksRootN);
}

async function findP4ConfigFiles(wksFolder: vscode.WorkspaceFolder) {
    const workspaceUri = wksFolder.uri;

    const configName = await PerforceService.getConfigFilename(workspaceUri);

    const pattern = new vscode.RelativePattern(wksFolder, `**/${configName}`);

    logInitProgress(workspaceUri, "Using pattern " + pattern.pattern);

    return await vscode.workspace.findFiles(pattern, "**/node_modules/**");
}

function clientRootLog(
    source: string,
    foundRoot: ClientRoot | undefined,
    hasWorkingDirOverride?: boolean,
    shouldAlwaysActivate?: boolean
) {
    if (!foundRoot) {
        return "  * " + source + " : NO CLIENT ROOT FOUND";
    }
    const ignoreMsg = hasWorkingDirOverride
        ? "USING ANYWAY because working dir override is set"
        : shouldAlwaysActivate
        ? "USING ANYWAY because activation mode is set to ALWAYS"
        : "IGNORING THIS CLIENT";
    return (
        "  * " +
        source +
        " :\n\tClient name: " +
        foundRoot.clientName +
        "\n\tClient root: " +
        foundRoot.clientRoot.fsPath +
        "\n\t" +
        (foundRoot.isInRoot || foundRoot.isAboveRoot
            ? "Folder IS in or above client root"
            : "Folder IS NOT in client root - " + ignoreMsg)
    );
}

function getActivationMode() {
    return (
        vscode.workspace.getConfiguration("perforce").get<string>("activationMode") ??
        "autodetect"
    );
}

function getOverrideInfo(workspaceUri: vscode.Uri) {
    const vsConfig = vscode.workspace.getConfiguration("perforce", workspaceUri);

    const overrides: [string, string | undefined][] = [
        ["perforce.port", vsConfig.get("port")],
        ["perforce.user", vsConfig.get("user")],
        ["perforce.client", vsConfig.get("client")],
        ["perforce.dir", vsConfig.get("dir")],
    ];

    return overrides
        .map((o) => {
            const prefix = "\t\t";
            const suffix =
                o[1] && o[1] !== "none" ? "\t(!OVERRIDE!)" : "\t(will not override)";
            return prefix + o[0] + ": " + o[1] + suffix;
        })
        .join("\n");
}

function initClientRoot(workspaceUri: vscode.Uri, client: ClientRoot): boolean {
    if (PerforceSCMProvider.GetInstanceByClient(client)) {
        logInitProgress(
            workspaceUri,
            "SCM provider already exists for " +
                client.clientName +
                " @ " +
                client.clientRoot.fsPath +
                " - not creating another for source : " +
                client.configSource.fsPath
        );
        return false;
    } else {
        logInitProgress(
            workspaceUri,
            "Creating SCM provider for " +
                client.clientName +
                " @ " +
                client.clientRoot.fsPath +
                " because of source : " +
                client.configSource.fsPath
        );

        const workspaceConfig = new WorkspaceConfigAccessor(client.configSource); // TODO doesn't make sense any more
        const scm = new PerforceSCMProvider(client, workspaceConfig);

        scm.Initialize();
        _disposable.push(scm);
        _disposable.push(new FileSystemActions(vscode.workspace, workspaceConfig));

        doOneTimeRegistration();
        Display.activateStatusBar();
        return true;
    }
}

function initClientRoots(workspaceUri: vscode.Uri, ...clientRoots: ClientRoot[]) {
    let created = 0;
    let ignored = 0;
    clientRoots.forEach((client) => {
        initClientRoot(workspaceUri, client) ? ++created : ++ignored;
    });

    logInitProgress(
        workspaceUri,
        `Initialisation done for this workspace. Created ${created} provider(s), ignored ${ignored} duplicate(s)\n\n`
    );
}

async function findClientRootsForP4Configs(wksFolder: vscode.WorkspaceFolder) {
    const workspaceUri = wksFolder.uri;
    logInitProgress(workspaceUri, "Looking for perforce config files");
    const p4ConfigFiles = await findP4ConfigFiles(wksFolder);

    logInitProgress(workspaceUri, "Found " + p4ConfigFiles.length + " config file(s)");

    logInitProgress(workspaceUri, "Finding client roots using each file's directory");
    const rootPromises = p4ConfigFiles.map(async (file) =>
        findClientRoot(vscode.Uri.file(Path.dirname(file.fsPath)))
    );
    const foundRoots = await Promise.all(rootPromises);

    const foundRootsStr = p4ConfigFiles
        .map((f, i) => clientRootLog(f.fsPath, foundRoots[i]))
        .join("\n");
    logInitProgress(
        workspaceUri,
        "Found the following roots from " +
            p4ConfigFiles.length +
            " P4CONFIG file(s):\n" +
            foundRootsStr
    );

    return foundRoots;
}

async function initWorkspace(wksFolder: vscode.WorkspaceFolder) {
    const workspaceUri = wksFolder.uri;

    const overrideDir = PerforceService.getOverrideDir(workspaceUri);
    const activationMode = getActivationMode();
    const shouldAlwaysActivate = activationMode === "always";

    logInitProgress(
        workspaceUri,
        "Inititalising this workspace.\n\tNote: the following overrides apply in this workspace:\n" +
            getOverrideInfo(workspaceUri) +
            "\n\tExplicit overrides may prevent auto-detection of other perforce client workspaces\n" +
            "Looking for a client root using the workspace root directory"
    );

    const workspaceClientRoot = await findClientRoot(workspaceUri);

    if (!workspaceClientRoot) {
        logInitProgress(workspaceUri, "NO CLIENT ROOT FOUND in workspace root directory");
    } else {
        logInitProgress(
            workspaceUri,
            "Found workspace using root directory\n" +
                clientRootLog(
                    "VS Code workspace root directory",
                    workspaceClientRoot,
                    !!overrideDir,
                    shouldAlwaysActivate
                )
        );
    }

    const allRoots = [workspaceClientRoot];

    if (overrideDir) {
        // if workspace is not in client root but p4dir is set, just use the client found.
        // don't care about anything else because p4dir pretty much overrides everything
        logInitProgress(
            workspaceUri,
            "NOT scanning for P4CONFIG files due to working directory override"
        );
    } else {
        const enableP4ConfigScan = vscode.workspace
            .getConfiguration("perforce", workspaceUri)
            .get<boolean>("enableP4ConfigScanOnStartup");

        if (!enableP4ConfigScan) {
            logInitProgress(
                workspaceUri,
                "NOT scanning for P4CONFIG files because perforce.enableP4ConfigScanOnStartup is set to false"
            );
        } else {
            const foundRoots = await findClientRootsForP4Configs(wksFolder);
            allRoots.push(...foundRoots.filter(isTruthy));
        }
    }

    const filteredRoots = allRoots
        .filter(isTruthy)
        .filter((r) => r.isInRoot || r.isAboveRoot);

    const helpMsg =
        "If you were expecting a valid client to be found:\n" +
        "  * Check if you can run perforce commands in this directory from the command line.\n" +
        "  * Look at the perforce commands above, see if they match your expectations and can be run in the directory shown.\n" +
        "  * Review your override settings in vscode, perforce.port, perforce.user, perforce.client, perforce.dir\n" +
        "    * you may need to set or unset them appropriately";

    if (filteredRoots.length < 1) {
        if (shouldAlwaysActivate) {
            if (workspaceClientRoot) {
                logInitProgress(
                    workspaceUri,
                    "NO valid perforce clients found in this directory, but activation mode is set to ALWAYS and a perforce client was found with a different client root\n" +
                        helpMsg +
                        "\n" +
                        "Creating SCM Provider using the workspace found in the root directory."
                );

                initClientRoots(workspaceUri, workspaceClientRoot);
            } else {
                logInitProgress(
                    workspaceUri,
                    "NO valid perforce clients found in this directory." +
                        "Activation mode is set to ALWAYS, but cannot create an scm provider without any client found.\n" +
                        "Note: It should still be possible to use perforce commands on individual files in the editor.\n" +
                        helpMsg
                );
            }
        } else {
            logInitProgress(
                workspaceUri,
                "NO valid perforce clients found in this directory.\n" + helpMsg
            );
        }
    } else {
        initClientRoots(workspaceUri, ...filteredRoots);
    }
    // TODO - we should pass in the client root information including the dir we used
    // to find the client. scm provider commands should be run **from this directory**
    // to account for cases e.g. where the real client root directory is configured with a
    // different perforce client to the one we found
    // this could happen if the perforce.client setting specifies a different client in a specific folder
    // probably the scm provider should accumulate all dirs used to find it, so that when
    // folders are files are removed we know if we still need the scm provider
}

export function activate(ctx: vscode.ExtensionContext): void {
    // ALWAYS register the edit and save command
    PerforceCommands.registerImportantCommands(_disposable);

    const activationMode = vscode.workspace
        .getConfiguration("perforce")
        .get("activationMode");
    if (activationMode === "off") {
        return;
    }

    doOneTimeRegistration();

    if (activationMode === "always") {
        Display.activateStatusBar();
    }

    QuickPicks.registerQuickPicks();

    ctx.subscriptions.push(
        new vscode.Disposable(() => Disposable.from(..._disposable).dispose())
    );

    vscode.workspace.onDidChangeWorkspaceFolders(
        onDidChangeWorkspaceFolders,
        null,
        ctx.subscriptions
    );
    onDidChangeWorkspaceFolders({
        added: vscode.workspace.workspaceFolders || [],
        removed: [],
    });

    vscode.workspace.onDidChangeConfiguration(
        onDidChangeConfiguration,
        null,
        ctx.subscriptions
    );
}

function doOneTimeRegistration() {
    if (!_isRegistered) {
        _isRegistered = true;

        Display.channel.appendLine(
            "Performing one-time registration of perforce commands"
        );

        Display.initialize(_disposable);
        ContextVars.initialize(_disposable);

        _perforceContentProvider = new PerforceContentProvider();
        _disposable.push(_perforceContentProvider);

        _disposable.push(
            AnnotationProvider.onWillLoadEditor((uri) =>
                _perforceContentProvider?.requestUpdatedDocument(uri)
            )
        );

        // todo: fix dependency / order of operations issues
        PerforceCommands.registerCommands();
        PerforceSCMProvider.registerCommands();
    }
}

const settingsRequiringRestart = [
    "perforce.activationMode",
    "perforce.editOnFileSave",
    "perforce.editOnFileModified",
    "perforce.addOnFileCreate",
    "perforce.deleteOnFileDelete",
    "perforce.client",
    "perforce.port",
    "perforce.user",
    "perforce.password",
    "perforce.dir",
    "perforce.command",
    "perforce.bottleneck.maxConcurrent",
];

let didShowConfigWarning = false;

async function onDidChangeConfiguration(event: vscode.ConfigurationChangeEvent) {
    if (didShowConfigWarning) {
        return;
    }

    for (const setting of settingsRequiringRestart) {
        if (event.affectsConfiguration(setting)) {
            didShowConfigWarning = true;
            const restart = "Restart Now";
            const answer = await vscode.window.showWarningMessage(
                "You have changed a perforce setting that may require a restart to take effect. When you are done, please restart VS Code",
                restart
            );
            if (answer === restart) {
                vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
            return;
        }
    }
}

async function onDidChangeWorkspaceFolders({
    added,
}: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
    Display.channel.appendLine(
        "==============================\nWorkspace folders changed. Starting initialisation.\n"
    );

    try {
        if (added !== undefined) {
            if (added.length > 0) {
                Display.channel.appendLine("Workspaces were added");
            } else {
                Display.channel.appendLine(
                    "No new workspaces were added - nothing to initialise"
                );
            }
            for (const workspace of added) {
                await initWorkspace(workspace);
                //await TryCreateP4(workspace.uri);
            }
        } else {
            Display.channel.appendLine("No workspaces. Trying all open documents");
            /*const promises = vscode.workspace.textDocuments.map((doc) =>
                TryCreateP4(doc.uri)
            );
            await Promise.all(promises);*/
            // TODO do something
        }
    } catch (err) {
        Display.channel.appendLine("Error: " + err);
    }

    Display.channel.appendLine(
        "\nInitialisation finished\n==============================\n"
    );
}
