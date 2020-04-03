import * as vscode from "vscode";

import * as PerforceUri from "../PerforceUri";
import * as p4 from "../api/PerforceApi";
import * as DiffProvider from "../DiffProvider";
import { Display } from "../Display";
import { AnnotationProvider } from "../annotations/AnnotationProvider";
import { isTruthy } from "../TsUtils";

import * as ChangeQuickPick from "./ChangeQuickPick";

import * as qp from "./QuickPickProvider";
import { showIntegPickForFile } from "./IntegrationQuickPick";
import { timeAgo, toReadableDateTime } from "../DateFormatter";

const nbsp = "\xa0";

export const fileQuickPickProvider: qp.ActionableQuickPickProvider = {
    provideActions: async (uri: vscode.Uri, cached?: CachedOutput) => {
        const changes = await getChangeDetails(uri, cached);
        const actions = makeNextAndPrevPicks(uri, changes).concat(
            makeDiffPicks(uri, changes),
            makeChangelistPicks(uri, changes)
        );
        return {
            items: actions,
            placeHolder: makeRevisionSummary(changes.current)
        };
    }
};

export async function showQuickPickForFile(uri: vscode.Uri, cached?: CachedOutput) {
    await qp.showQuickPick("file", uri, cached);
}

export const fileRevisionQuickPickProvider: qp.ActionableQuickPickProvider = {
    provideActions: async (
        uri: vscode.Uri,
        includeIntegrations: boolean,
        includeIntegrationTargets: boolean,
        cached?: CachedOutput
    ) => {
        const changes = await getChangeDetails(uri, cached);
        const actions = makeAllRevisionPicks(
            uri,
            changes,
            includeIntegrations,
            includeIntegrationTargets
        );
        return {
            items: actions,
            excludeFromHistory: true,
            placeHolder:
                "Choose revision for " +
                changes.current.file +
                "#" +
                changes.current.revision
        };
    }
};

export async function showRevChooserForFile(uri: vscode.Uri, cached?: CachedOutput) {
    await qp.showQuickPick("filerev", uri, false, false, cached);
}

async function showRevChooserWithIntegrations(
    uri: vscode.Uri,
    includeIntegrations: boolean,
    includeIntegrationTargets: boolean,
    cached?: CachedOutput
) {
    await qp.showQuickPick(
        "filerev",
        uri,
        includeIntegrations,
        includeIntegrationTargets,
        cached
    );
}

export const fileDiffQuickPickProvider: qp.ActionableQuickPickProvider = {
    provideActions: async (uri: vscode.Uri) => {
        const changes = await getChangeDetails(uri, undefined, true);
        const actions = makeDiffRevisionPicks(uri, changes);
        return {
            items: actions,
            excludeFromHistory: true,
            placeHolder:
                "Diff revision for " +
                changes.current.file +
                "#" +
                changes.current.revision
        };
    }
};

export async function showDiffChooserForFile(uri: vscode.Uri) {
    await qp.showQuickPick("filediff", uri);
}

type CachedOutput = {
    filelog: p4.FileLogItem[];
};

type ChangeDetails = {
    all: p4.FileLogItem[];
    current: p4.FileLogItem;
    currentIndex: number;
    next?: p4.FileLogItem;
    prev?: p4.FileLogItem;
    latest: p4.FileLogItem;
};

function makeRevisionSummary(change: p4.FileLogItem) {
    return (
        change.file +
        "#" +
        change.revision +
        " " +
        change.operation +
        " on " +
        toReadableDateTime(change.date) +
        " by " +
        change.user +
        " : " +
        change.description
    );
}

function makeShortSummary(change: p4.FileLogItem) {
    return (
        "#" +
        change.revision +
        (change.date ? "  $(calendar) " + timeAgo.format(change.date) : "") +
        " $(person) " +
        change.user +
        " $(circle-filled) " +
        change.description.slice(0, 32)
    );
}

async function getChangeDetails(
    uri: vscode.Uri,
    cached?: CachedOutput,
    followBranches?: boolean
): Promise<ChangeDetails> {
    const rev = uri.fragment;
    if (!uri.fragment) {
        throw new Error("TODO - no revision");
    }
    const revNum = parseInt(rev);
    if (isNaN(revNum)) {
        throw new Error("TODO - not a revision");
        // TODO handle shelved files - need pending changelists for this - so not possible yet
    }

    const arg = PerforceUri.fromUriWithRevision(uri, "");

    const filelog =
        cached?.filelog ??
        (await p4.getFileHistory(uri, { file: arg, followBranches: followBranches }));

    if (filelog.length === 0) {
        Display.showImportantError("No file history found");
        throw new Error("Filelog info empty");
    }

    const currentIndex = filelog.findIndex(c => c.revision === uri.fragment);
    const current = filelog[currentIndex];
    const next = filelog[currentIndex - 1];
    const prev = filelog[currentIndex + 1];
    const latest = filelog[0];

    return { all: filelog, current, currentIndex, next, prev, latest };
}

function makeAllRevisionPicks(
    uri: vscode.Uri,
    changes: ChangeDetails,
    includeIntegrations: boolean,
    includeIntegrationTargets: boolean
): qp.ActionableQuickPickItem[] {
    const revPicks = changes.all.flatMap(change => {
        const icon =
            change === changes.current ? "$(location)" : "$(debug-stackframe-dot)";
        const fromRev = includeIntegrations
            ? change.integrations.find(c => c.direction === p4.Direction.FROM)
            : undefined;
        const toRevs = includeIntegrationTargets
            ? change.integrations.filter(c => c.direction === p4.Direction.TO)
            : [];

        const revPick: qp.ActionableQuickPickItem = {
            label: icon + " #" + change.revision,
            description: change.description,
            detail:
                nbsp.repeat(10) +
                change.operation +
                " $(person) " +
                change.user +
                nbsp +
                " $(calendar) " +
                nbsp +
                toReadableDateTime(change.date),
            performAction: () => {
                const revUri = PerforceUri.fromDepotPath(
                    PerforceUri.getUsableWorkspace(uri) ?? uri,
                    change.file,
                    change.revision
                );
                return showQuickPickForFile(revUri, { filelog: changes.all });
            }
        };

        const fromPick: qp.ActionableQuickPickItem | undefined = fromRev
            ? {
                  label:
                      nbsp.repeat(10) +
                      "$(git-merge) " +
                      fromRev.operation +
                      " from " +
                      fromRev.file +
                      "#" +
                      fromRev.startRev +
                      "," +
                      fromRev.endRev,
                  performAction: () => {
                      const revUri = PerforceUri.fromDepotPath(
                          PerforceUri.getUsableWorkspace(uri) ?? uri,
                          fromRev.file,
                          fromRev.endRev
                      );
                      return showQuickPickForFile(revUri);
                  }
              }
            : undefined;

        const toPicks = toRevs.map(rev => {
            return {
                label:
                    nbsp.repeat(10) +
                    "$(source-control) " +
                    rev.operation +
                    " into " +
                    rev.file +
                    "#" +
                    rev.startRev,
                performAction: () => {
                    const revUri = PerforceUri.fromDepotPath(
                        PerforceUri.getUsableWorkspace(uri) ?? uri,
                        rev.file,
                        rev.startRev
                    );
                    return showQuickPickForFile(revUri);
                }
            };
        });

        return [revPick, ...toPicks, fromPick].filter(isTruthy);
    });

    const controls: qp.ActionableQuickPickItem[] = [
        {
            label: includeIntegrationTargets
                ? "$(exclude) Hide integration target files"
                : "$(gear) Show integration target files",
            performAction: () => {
                return showRevChooserWithIntegrations(
                    uri,
                    includeIntegrations,
                    !includeIntegrationTargets,
                    {
                        filelog: changes.all
                    }
                );
            }
        },
        {
            label: includeIntegrations
                ? "$(exclude) Hide integration source files"
                : "$(gear) Show integration source files",
            performAction: () => {
                return showRevChooserWithIntegrations(
                    uri,
                    !includeIntegrations,
                    includeIntegrationTargets,
                    {
                        filelog: changes.all
                    }
                );
            }
        }
    ];

    return controls.concat(revPicks);
}

function makeDiffRevisionPicks(
    uri: vscode.Uri,
    changes: ChangeDetails
): qp.ActionableQuickPickItem[] {
    const currentUri = PerforceUri.fromDepotPath(
        PerforceUri.getUsableWorkspace(uri) ?? uri,
        changes.current.file,
        changes.current.revision
    );
    return changes.all.map((change, i) => {
        const prefix =
            change === changes.current
                ? "$(location) "
                : change.file === changes.current.file
                ? "$(debug-stackframe-dot) "
                : "$(git-merge) " + change.file;
        const isOldRev = i > changes.currentIndex;
        return {
            label: prefix + "#" + change.revision,
            description:
                change.operation +
                " by " +
                change.user +
                " : " +
                change.description.slice(0, 32),
            performAction: () => {
                const thisUri = PerforceUri.fromDepotPath(
                    PerforceUri.getUsableWorkspace(uri) ?? uri,
                    change.file,
                    change.revision
                );
                DiffProvider.diffFiles(
                    isOldRev ? thisUri : currentUri,
                    isOldRev ? currentUri : thisUri
                );
            }
        };
    });
}

function makeNextAndPrevPicks(
    uri: vscode.Uri,
    changes: ChangeDetails
): qp.ActionableQuickPickItem[] {
    const prev = changes.prev;
    const next = changes.next;
    const integFrom = changes.current.integrations.find(
        i => i.direction === p4.Direction.FROM
    );
    return [
        prev
            ? {
                  label: "$(arrow-small-left) Previous revision",
                  description: makeShortSummary(prev),
                  performAction: () => {
                      const prevUri = PerforceUri.fromDepotPath(
                          PerforceUri.getUsableWorkspace(uri) ?? uri,
                          prev.file,
                          prev.revision
                      );
                      return showQuickPickForFile(prevUri, { filelog: changes.all });
                  }
              }
            : {
                  label: "$(arrow-small-left) Previous revision",
                  description: "n/a",
                  performAction: () => {
                      return showQuickPickForFile(uri, { filelog: changes.all });
                  }
              },
        next
            ? {
                  label: "$(arrow-small-right) Next revision",
                  description: makeShortSummary(next),
                  performAction: () => {
                      const nextUri = PerforceUri.fromDepotPath(
                          PerforceUri.getUsableWorkspace(uri) ?? uri,
                          next.file,
                          next.revision
                      );
                      return showQuickPickForFile(nextUri, { filelog: changes.all });
                  }
              }
            : {
                  label: "$(arrow-small-right) Next revision",
                  description: "n/a",
                  performAction: () => {
                      return showQuickPickForFile(uri, { filelog: changes.all });
                  }
              },
        {
            label: "$(symbol-numeric) File history...",
            description: "Go to a specific revision",
            performAction: () => {
                showRevChooserForFile(uri, { filelog: changes.all });
            }
        },
        integFrom
            ? {
                  label: "$(git-merge) Go to integration source revision",
                  description:
                      integFrom.operation +
                      " from " +
                      integFrom.file +
                      "#" +
                      integFrom.endRev,
                  performAction: () => {
                      const integUri = PerforceUri.fromDepotPath(
                          PerforceUri.getUsableWorkspace(uri) ?? uri,
                          integFrom.file,
                          integFrom.endRev
                      );
                      return showQuickPickForFile(integUri);
                  }
              }
            : undefined,
        {
            label: "$(source-control) Go to integration target...",
            description: "See integrations that include this revision",
            performAction: () => showIntegPickForFile(uri)
        }
    ].filter(isTruthy);
}

function makeDiffPicks(
    uri: vscode.Uri,
    changes: ChangeDetails
): qp.ActionableQuickPickItem[] {
    const prev = changes.prev;
    const latest = changes.latest;
    return [
        {
            label: "$(file) Show this revision",
            performAction: () => {
                vscode.window.showTextDocument(uri);
            }
        },
        {
            label: "$(list-ordered) Annotate",
            performAction: () => {
                // TODO SWARM HOST
                AnnotationProvider.annotate(uri);
            }
        },
        prev
            ? {
                  label: "$(diff) Diff against previous revision",
                  description: DiffProvider.diffTitleForDepotPaths(
                      prev.file,
                      prev.revision,
                      changes.current.file,
                      changes.current.revision
                  ),
                  performAction: () => DiffProvider.diffPreviousIgnoringLeftInfo(uri)
              }
            : undefined,
        latest !== changes.current
            ? {
                  label: "$(diff) Diff against latest revision",
                  description: DiffProvider.diffTitleForDepotPaths(
                      changes.current.file,
                      changes.current.revision,
                      latest.file,
                      latest.revision
                  ),
                  performAction: () =>
                      DiffProvider.diffFiles(
                          PerforceUri.fromDepotPath(
                              PerforceUri.getUsableWorkspace(uri) ?? uri,
                              changes.current.file,
                              changes.current.revision
                          ),
                          PerforceUri.fromDepotPath(
                              PerforceUri.getUsableWorkspace(uri) ?? uri,
                              latest.file,
                              latest.revision
                          )
                      )
              }
            : undefined,
        {
            label: "$(diff) Diff against workspace file",
            performAction: () => {
                // do this in the diff provider
                Display.showMessage("TODO - work out workspace file for a depot file");
            }
        },
        {
            label: "$(diff) Diff against...",
            description: "Choose another revision to diff against",
            performAction: () => {
                showDiffChooserForFile(uri);
            }
        }
    ].filter(isTruthy);
}

function makeChangelistPicks(
    uri: vscode.Uri,
    changes: ChangeDetails
): qp.ActionableQuickPickItem[] {
    return [
        {
            label: "$(list-flat) Go to changelist details",
            description: "Change " + changes.current.chnum,
            performAction: () =>
                ChangeQuickPick.showQuickPickForChangelist(uri, changes.current.chnum)
        }
    ];
}
