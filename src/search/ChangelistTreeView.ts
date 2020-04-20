import * as vscode from "vscode";

import {
    SelfExpandingTreeView as SelfExpandingTreeProvider,
    SelfExpandingTreeItem,
    SelfExpandingTreeRoot,
} from "../TreeView";
import { PerforceSCMProvider } from "../ScmProvider";
import { ClientRoot } from "../extension";
import * as Path from "path";
import {
    FilterItem,
    FilterRootItem,
    Filters,
    FileFilterRoot,
    FileFilterValue,
    makeFilterLabelText,
} from "./Filters";
import {
    showQuickPickForChangelist,
    getOperationIcon,
} from "../quickPick/ChangeQuickPick";
import { Display } from "../Display";
import * as p4 from "../api/PerforceApi";
import { ChangeInfo } from "../api/CommonTypes";
import { isPositiveOrZero } from "../TsUtils";
import { ProviderSelection } from "./ProviderSelection";
import { configAccessor } from "../ConfigService";
import { showQuickPickForChangeSearch } from "../quickPick/ChangeSearchQuickPick";
import { DescribedChangelist } from "../api/PerforceApi";
import * as PerforceUri from "../PerforceUri";

class ChooseProviderTreeItem extends SelfExpandingTreeItem<any> {
    constructor(private _providerSelection: ProviderSelection) {
        super("Context:", vscode.TreeItemCollapsibleState.None);

        this._subscriptions.push(
            PerforceSCMProvider.onDidChangeScmProviders(
                this.onDidChangeScmProviders.bind(this)
            )
        );
        this._subscriptions.push(
            _providerSelection.onDidChangeProvider((client) => {
                if (client) {
                    this.description = client.clientName + " / " + client.userName;
                } else {
                    this.description = "<choose a perforce instance>";
                }
                this.didChange();
            })
        );

        this.setClient(PerforceSCMProvider.clientRoots[0]);
    }

    get selectedClient() {
        return this._providerSelection.client;
    }

    private setClient(client?: ClientRoot) {
        this._providerSelection.client = client;
    }

    private onDidChangeScmProviders() {
        if (
            !this.selectedClient ||
            !PerforceSCMProvider.GetInstanceByClient(this.selectedClient)
        ) {
            this.setClient(PerforceSCMProvider.clientRoots[0]);
        }
    }

    get iconPath() {
        return new vscode.ThemeIcon("account");
    }

    public get command(): vscode.Command {
        return {
            command: "perforce.changeSearch.chooseProvider",
            title: "Choose Provider",
            tooltip: "Choose a perforce instance for performing the search",
            arguments: [this],
        };
    }

    public async chooseProvider() {
        const items = PerforceSCMProvider.clientRoots.map<
            vscode.QuickPickItem & { client: ClientRoot }
        >((client) => {
            return {
                label: Path.basename(client.clientRoot.fsPath),
                description: client.clientName + " $(person) " + client.userName,
                client,
            };
        });
        const chosen = await vscode.window.showQuickPick(items, {
            matchOnDescription: true,
            placeHolder: "Choose a perforce instance to use as context for the search",
        });

        if (chosen && chosen.client !== this.selectedClient) {
            this.setClient(chosen.client);
        }
    }

    public tooltip = "Choose a perforce instance to use as context for the search";
}

class GoToChangelist extends SelfExpandingTreeItem<any> {
    constructor(private _chooseProvider: ChooseProviderTreeItem) {
        super("Go to changelist...");
    }

    async execute() {
        const selectedClient = this._chooseProvider.selectedClient;
        if (!selectedClient) {
            Display.showImportantError(
                "Please choose a context before entering a changelist number"
            );
            throw new Error("No context for changelist search");
        }

        const clipValue = await vscode.env.clipboard.readText();
        const value = isPositiveOrZero(clipValue) ? clipValue : undefined;

        const chnum = await vscode.window.showInputBox({
            placeHolder: "Changelist number",
            prompt: "Enter a changelist number",
            value,
            validateInput: (value) => {
                if (!isPositiveOrZero(value)) {
                    return "must be a positive number";
                }
            },
        });
        if (chnum !== undefined) {
            showQuickPickForChangelist(selectedClient.configSource, chnum);
        }
    }

    get command(): vscode.Command {
        return {
            command: "perforce.changeSearch.goToChangelist",
            arguments: [this],
            title: "Go to changelist",
        };
    }

    get iconPath() {
        return new vscode.ThemeIcon("rocket");
    }
}

class RunSearch extends SelfExpandingTreeItem<any> {
    constructor(private _root: ChangelistTreeRoot) {
        super("Search Now");
    }

    get command(): vscode.Command {
        return {
            command: "perforce.changeSearch.run",
            arguments: [this._root],
            title: "Run Search",
        };
    }

    get iconPath() {
        return new vscode.ThemeIcon("search");
    }
}

class SearchResultFile extends SelfExpandingTreeItem<any> {
    constructor(private _clientRoot: ClientRoot, private _file: p4.DepotFileOperation) {
        super(_file.depotPath + "#" + _file.revision);
        this.description = _file.operation;
    }

    get iconPath() {
        return new vscode.ThemeIcon(getOperationIcon(this._file.operation));
    }

    get command() {
        return {
            command: "perforce.showQuickPick",
            arguments: [
                "file",
                PerforceUri.fromDepotPath(
                    this._clientRoot.configSource,
                    this._file.depotPath,
                    this._file.revision
                ).toString(),
            ],
            title: "Show file quick pick",
        };
    }
}

class SearchResultItem extends SelfExpandingTreeItem<SearchResultFile> {
    constructor(private _clientRoot: ClientRoot, private _change: ChangeInfo) {
        super(
            _change.chnum + ": " + _change.description.join(" ").slice(0, 32),
            vscode.TreeItemCollapsibleState.None
        );
        this.description = _change.user;
    }

    get chnum() {
        return this._change.chnum;
    }

    addDetails(detail: DescribedChangelist) {
        this.clearChildren();
        const files = detail.affectedFiles.map(
            (file) => new SearchResultFile(this._clientRoot, file)
        );
        files.forEach((file) => this.addChild(file));
        const curState = this.collapsibleState;
        this.collapsibleState =
            curState === vscode.TreeItemCollapsibleState.Expanded
                ? curState
                : vscode.TreeItemCollapsibleState.Collapsed;
    }

    get iconPath() {
        return new vscode.ThemeIcon(
            this._change.status === "pending" ? "tools" : "check"
        );
    }

    get command(): vscode.Command {
        return {
            command: "perforce.showQuickPick",
            arguments: [
                "change",
                this._clientRoot.configSource.toString(),
                this._change.chnum,
            ],
            title: "Show changelist quick pick",
        };
    }
}

interface Pinnable extends vscode.Disposable {
    pin: () => void;
    unpin: () => void;
    pinned: boolean;
}

function isPinnable(obj: any): obj is Pinnable {
    return obj && obj.pin && obj.unpin;
}

class SearchResultTree extends SelfExpandingTreeItem<SearchResultItem>
    implements Pinnable {
    private _isPinned: boolean = false;
    constructor(
        private _clientRoot: ClientRoot,
        private _filters: Filters,
        private _results: ChangeInfo[]
    ) {
        super(
            SearchResultTree.makeLabelText(_filters, _results),
            vscode.TreeItemCollapsibleState.Expanded
        );
        const children = _results.map((r) => new SearchResultItem(_clientRoot, r));
        children.forEach((child) => this.addChild(child));
        this.populateChangeDetails();
    }

    static makeLabelText(filters: Filters, results: ChangeInfo[]) {
        return makeFilterLabelText(filters, results.length);
    }

    async populateChangeDetails() {
        const allChanges = this._results.map((r) => r.chnum);
        const descriptions = await p4.describe(this._clientRoot.configSource, {
            omitDiffs: true,
            chnums: allChanges,
        });
        const curChildren = this.getChildren();
        descriptions.forEach((d) => {
            const child = curChildren.find((c) => c.chnum === d.chnum);
            child?.addDetails(d);
        });
        this.didChange();
    }

    async refresh() {
        this._results = await executeSearch(this._clientRoot, this._filters);
        this.clearChildren();
        const children = this._results.map(
            (r) => new SearchResultItem(this._clientRoot, r)
        );
        children.forEach((child) => this.addChild(child));
        this.reveal();
        this.populateChangeDetails();
    }

    pin() {
        this._isPinned = true;
        this.didChange();
    }

    unpin() {
        this._isPinned = false;
        this.didChange();
    }

    get pinned() {
        return this._isPinned;
    }

    get contextValue() {
        return this._isPinned ? "results-pinned" : "results-unpinned";
    }

    showInQuickPick() {
        showResultsInQuickPick(
            this._clientRoot.configSource,
            this._filters,
            this._results
        );
    }
}

class AllResultsTree extends SelfExpandingTreeItem<SearchResultTree> {
    constructor() {
        super("Results", vscode.TreeItemCollapsibleState.Expanded, {
            reverseChildren: true,
        });
    }

    addResults(selectedClient: ClientRoot, filters: Filters, results: ChangeInfo[]) {
        this.removeUnpinned();
        const child = new SearchResultTree(selectedClient, filters, results);
        this.addChild(child);
        child.reveal({ expand: true });
    }

    removeUnpinned() {
        const children = this.getChildren();
        children.forEach((child) => {
            if (isPinnable(child) && !child.pinned) {
                child.dispose();
            }
        });
    }
}

function showResultsInQuickPick(
    resource: vscode.Uri,
    filters: Filters,
    results: ChangeInfo[]
) {
    return showQuickPickForChangeSearch(resource, filters, results);
}

async function executeSearch(
    selectedClient: ClientRoot,
    filters: Filters
): Promise<ChangeInfo[]> {
    const maxChangelists = configAccessor.changelistSearchMaxResults;
    return await vscode.window.withProgress(
        { location: { viewId: "perforce.searchChangelists" } },
        () =>
            p4.getChangelists(selectedClient.configSource, {
                ...filters,
                maxChangelists,
            })
    );
}

class ChangelistTreeRoot extends SelfExpandingTreeRoot<any> {
    private _chooseProvider: ChooseProviderTreeItem;
    private _filterRoot: FilterRootItem;
    private _allResults: AllResultsTree;
    private _providerSelection: ProviderSelection;

    constructor() {
        super();
        this._providerSelection = new ProviderSelection();
        this._subscriptions.push(this._providerSelection);
        this._chooseProvider = new ChooseProviderTreeItem(this._providerSelection);
        this._filterRoot = new FilterRootItem(this._providerSelection);
        this._allResults = new AllResultsTree();
        this.addChild(this._chooseProvider);
        this.addChild(new GoToChangelist(this._chooseProvider));
        this.addChild(this._filterRoot);
        this.addChild(new RunSearch(this));
        this.addChild(this._allResults);
    }

    async executeSearch() {
        const selectedClient = this._chooseProvider.selectedClient;
        if (!selectedClient) {
            Display.showImportantError("Please choose a context before searching");
            throw new Error("No context for changelist search");
        }
        const filters = this._filterRoot.currentFilters;
        const results = await executeSearch(selectedClient, filters);

        this._allResults.addResults(selectedClient, filters, results);
        this.didChange();
    }
}

export function registerChangelistSearch() {
    vscode.commands.registerCommand(
        "perforce.changeSearch.chooseProvider",
        (arg: ChooseProviderTreeItem) => arg.chooseProvider()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.resetFilters",
        (arg: FilterRootItem) => arg.resetAllFilters()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.resetFilter",
        (arg: FilterItem<any>) => arg.reset()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.setFilter",
        (arg: FilterItem<any>) => arg.requestNewValue()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.addFileFilter",
        (arg: FileFilterRoot) => arg.addNewFilter()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.editFileFilter",
        (arg: FileFilterValue) => arg.edit()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.removeFileFilter",
        (arg: FileFilterValue) => arg.dispose()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.goToChangelist",
        (arg: GoToChangelist) => arg.execute()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.run",
        (arg: ChangelistTreeRoot) => arg.executeSearch()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.refresh",
        (arg: SearchResultTree) => arg.refresh()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.pin",
        (arg: SearchResultTree) => arg.pin()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.unpin",
        (arg: SearchResultTree) => arg.unpin()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.delete",
        (arg: SearchResultTree) => arg.dispose()
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.showInQuickPick",
        (arg: SearchResultTree) => arg.showInQuickPick()
    );

    const treeDataProvider = new SelfExpandingTreeProvider(new ChangelistTreeRoot());
    const treeView = vscode.window.createTreeView("perforce.searchChangelists", {
        treeDataProvider,
        canSelectMany: false,
        showCollapseAll: true,
    });
    treeDataProvider.treeView = treeView;
}
