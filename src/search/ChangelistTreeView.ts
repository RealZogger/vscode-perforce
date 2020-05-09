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
    getOperationIcon,
    showQuickPickForChangelist,
} from "../quickPick/ChangeQuickPick";
import { Display } from "../Display";
import * as p4 from "../api/PerforceApi";
import { ChangeInfo } from "../api/CommonTypes";
import { dedupe } from "../TsUtils";
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

        const chnum = await Display.requestChangelistNumber();

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
    private _autoRefresh: boolean;

    constructor(private _root: ChangelistTreeRoot) {
        super(RunSearch.makeLabel(false));
        this._autoRefresh = false;
    }

    private static makeLabel(autoRefresh: boolean) {
        return "Search Now\t(Auto: " + (autoRefresh ? "on" : "off") + ")";
    }

    get autoRefresh() {
        return this._autoRefresh;
    }

    set autoRefresh(autoRefresh: boolean) {
        this._autoRefresh = autoRefresh;
        this.label = RunSearch.makeLabel(this._autoRefresh);
        this.didChange();
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

    get contextValue() {
        return this._autoRefresh ? "searchNow-auto" : "searchNow-manual";
    }

    tooltip = "Apply current filters";
}

class SearchResultShelvedFile extends SelfExpandingTreeItem<any> {
    constructor(
        private _resource: vscode.Uri,
        private _file: p4.DepotFileOperation,
        private _chnum: string
    ) {
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
                "shelvedFile",
                (
                    PerforceUri.getUsableWorkspace(this._resource) ?? this._resource
                ).toString(),
                JSON.stringify(this._file),
                this._chnum,
            ],
            title: "Show shelved file quick pick",
        };
    }
}

class SearchResultShelvedSubTree extends SelfExpandingTreeItem<SearchResultShelvedFile> {
    constructor(resource: vscode.Uri, change: DescribedChangelist) {
        super(
            "Shelved Files (" + change.shelvedFiles.length + ")",
            vscode.TreeItemCollapsibleState.Collapsed
        );
        const files = change.shelvedFiles.map(
            (file) => new SearchResultShelvedFile(resource, file, change.chnum)
        );
        files.forEach((file) => this.addChild(file));
    }

    get iconPath() {
        return new vscode.ThemeIcon("files");
    }
}

class SearchResultFile extends SelfExpandingTreeItem<any> {
    constructor(private _resource: vscode.Uri, private _file: p4.DepotFileOperation) {
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
                    PerforceUri.getUsableWorkspace(this._resource) ?? this._resource,
                    this._file.depotPath,
                    this._file.revision
                ).toString(),
            ],
            title: "Show file quick pick",
        };
    }
}

class SearchResultItem extends SelfExpandingTreeItem<
    SearchResultFile | SearchResultShelvedSubTree
> {
    constructor(private _resource: vscode.Uri, private _change: ChangeInfo) {
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
            (file) => new SearchResultFile(this._resource, file)
        );
        files.forEach((file) => this.addChild(file));
        const curState = this.collapsibleState;
        this.collapsibleState =
            curState === vscode.TreeItemCollapsibleState.Expanded
                ? curState
                : vscode.TreeItemCollapsibleState.Collapsed;
    }

    addShelvedFiles(detail: DescribedChangelist) {
        // remove any existing shelved file group, in case of timing issues
        this.getChildren()
            .filter((child) => child.label?.startsWith("Shelved Files"))
            .forEach((child) => child.dispose());
        if (detail.shelvedFiles.length > 0) {
            this.insertChild(new SearchResultShelvedSubTree(this._resource, detail));
        }
    }

    get iconPath() {
        return new vscode.ThemeIcon(this._change.isPending ? "tools" : "check");
    }

    get command(): vscode.Command {
        return {
            command: "perforce.showQuickPick",
            arguments: ["change", this._resource.toString(), this._change.chnum],
            title: "Show changelist quick pick",
        };
    }

    get tooltip() {
        return this._change.description.join(" ");
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

abstract class SearchResultTree extends SelfExpandingTreeItem<SearchResultItem> {
    private _isPinned: boolean = false;
    private _results: ChangeInfo[];

    constructor(private _resource: vscode.Uri, results: ChangeInfo[], label: string) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this._results = dedupe(results, "chnum"); // with multiple file paths, p4 returns duplicates
        const children = this._results.map((r) => new SearchResultItem(this.resource, r));
        children.forEach((child) => this.addChild(child));
        this.populateChangeDetails();
    }

    protected get results() {
        return this._results;
    }

    protected get resource() {
        return this._resource;
    }

    protected async populateChangeDetails() {
        const allChanges = this._results.map((r) => r.chnum);
        const descriptions = await p4.describe(this._resource, {
            omitDiffs: true,
            chnums: allChanges,
        });
        const curChildren = this.getChildren();
        descriptions.forEach((d) => {
            const child = curChildren.find((c) => c.chnum === d.chnum);
            child?.addDetails(d);
        });
        this.didChange();
        this.populateShelvedFiles();
    }

    async populateShelvedFiles() {
        try {
            const couldHaveShelved = this._results
                .filter((r) => r.isPending)
                .map((r) => r.chnum);
            if (couldHaveShelved.length < 1) {
                return;
            }
            const shelvedDescriptions = await p4.describe(this._resource, {
                omitDiffs: true,
                chnums: couldHaveShelved,
                shelved: true,
            });
            const curChildren = this.getChildren();
            shelvedDescriptions.forEach((d) => {
                const child = curChildren.find((c) => c.chnum === d.chnum);
                child?.addShelvedFiles(d);
            });
            this.didChange();
        } catch (err) {}
    }

    public async refresh() {
        this._results = dedupe(await this.getNewResults(), "chnum");
        this.clearChildren();
        const children = this._results.map(
            (r) => new SearchResultItem(this._resource, r)
        );
        children.forEach((child) => this.addChild(child));
        this.reveal();
        this.populateChangeDetails();
    }

    protected abstract getNewResults(): Promise<ChangeInfo[]>;

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
            this._resource,
            this.label ?? "Search Results",
            this._results
        );
    }
}

class SingleChangeResultTree extends SearchResultTree {
    constructor(resource: vscode.Uri, private _result: DescribedChangelist) {
        super(resource, [_result], "Focused changelist " + _result.chnum);
        this.pin();
    }

    async getNewResults() {
        return await p4.describe(this.resource, {
            chnums: [this._result.chnum],
            omitDiffs: true,
        });
    }
}

class MultiSearchResultTree extends SearchResultTree implements Pinnable {
    constructor(resource: vscode.Uri, private _filters: Filters, results: ChangeInfo[]) {
        super(resource, results, MultiSearchResultTree.makeLabelText(_filters, results));
    }

    private static makeLabelText(filters: Filters, results: ChangeInfo[]) {
        return makeFilterLabelText(filters, results.length);
    }

    async getNewResults() {
        return await executeSearch(this.resource, this._filters);
    }
}

class AllResultsTree extends SelfExpandingTreeItem<
    SearchResultTree | SingleChangeResultTree
> {
    constructor() {
        super("Results", vscode.TreeItemCollapsibleState.Expanded, {
            reverseChildren: true,
        });
    }

    addResults(selectedClient: ClientRoot, filters: Filters, results: ChangeInfo[]) {
        this.removeUnpinned();
        const child = new MultiSearchResultTree(
            selectedClient.configSource,
            filters,
            results
        );
        this.addChild(child);
        this.didChange();
        child.reveal({ expand: true });
    }

    addSingleResult(resource: vscode.Uri, result: DescribedChangelist) {
        const child = new SingleChangeResultTree(resource, result);
        this.addChild(child);
        this.didChange();
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
    label: string,
    results: ChangeInfo[]
) {
    return showQuickPickForChangeSearch(resource, label, results);
}

async function executeSearch(
    resource: vscode.Uri,
    filters: Filters
): Promise<ChangeInfo[]> {
    const maxChangelists = configAccessor.changelistSearchMaxResults;
    return await vscode.window.withProgress(
        { location: { viewId: "perforce.searchChangelists" } },
        () =>
            p4.getChangelists(resource, {
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
    private _runSearch: RunSearch;

    constructor() {
        super();
        this._providerSelection = new ProviderSelection();
        this._subscriptions.push(this._providerSelection);
        this._chooseProvider = new ChooseProviderTreeItem(this._providerSelection);
        this._filterRoot = new FilterRootItem(this._providerSelection);
        this._allResults = new AllResultsTree();
        this._runSearch = new RunSearch(this);
        this._subscriptions.push(
            this._filterRoot.onDidChangeFilters(() => {
                if (this._runSearch.autoRefresh) {
                    this.executeSearch();
                }
            })
        );
        this._subscriptions.push(
            this._runSearch.onChanged(() => {
                if (this._runSearch.autoRefresh) {
                    this.executeSearch();
                }
            })
        );
        this.addChild(this._chooseProvider);
        this.addChild(new GoToChangelist(this._chooseProvider));
        this.addChild(this._filterRoot);
        this.addChild(this._runSearch);
        this.addChild(this._allResults);
    }

    async executeSearch() {
        const selectedClient = this._chooseProvider.selectedClient;
        if (!selectedClient) {
            Display.showImportantError("Please choose a context before searching");
            throw new Error("No context for changelist search");
        }
        const filters = this._filterRoot.currentFilters;
        const results = await executeSearch(selectedClient.configSource, filters);

        this._allResults.addResults(selectedClient, filters, results);
        this.didChange();
    }

    focusChangelist(resource: vscode.Uri, described: DescribedChangelist) {
        this._allResults.addSingleResult(resource, described);
        this.didChange();
        vscode.commands.executeCommand("perforce.searchChangelists.focus");
    }
}

let changelistTree: ChangelistTreeRoot;

export function focusChangelist(resource: vscode.Uri, described: DescribedChangelist) {
    changelistTree.focusChangelist(resource, described);
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

    vscode.commands.registerCommand(
        "perforce.changeSearch.enableAutoRefresh",
        (arg: RunSearch) => (arg.autoRefresh = true)
    );

    vscode.commands.registerCommand(
        "perforce.changeSearch.disableAutoRefresh",
        (arg: RunSearch) => (arg.autoRefresh = false)
    );

    changelistTree = new ChangelistTreeRoot();
    const treeDataProvider = new SelfExpandingTreeProvider(changelistTree);
    const treeView = vscode.window.createTreeView("perforce.searchChangelists", {
        treeDataProvider,
        canSelectMany: false,
        showCollapseAll: true,
    });
    treeDataProvider.treeView = treeView;
}
