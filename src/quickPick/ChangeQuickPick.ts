import * as vscode from "vscode";

import * as PerforceUri from "../PerforceUri";
import * as p4 from "../api/PerforceApi";

import * as qp from "./QuickPickProvider";
import { Display } from "../Display";
import { DescribedChangelist } from "../api/PerforceApi";
import { showQuickPickForFile } from "./FileQuickPick";
import { toReadableDateTime } from "../DateFormatter";

const nbsp = "\xa0";

export const changeQuickPickProvider: qp.ActionableQuickPickProvider = {
    provideActions: async (
        resource: vscode.Uri,
        chnum: string
    ): Promise<qp.ActionableQuickPick> => {
        const changes = await p4.describe(resource, { chnums: [chnum], omitDiffs: true });

        if (changes.length < 1) {
            Display.showImportantError("Unable to find change details");
            throw new Error("Unable to find change details");
        }

        const change = changes[0];
        const actions = makeJobPicks(resource, changes[0]).concat(
            makeFilePicks(resource, change)
        );

        return {
            items: actions,
            placeHolder:
                "Change " +
                chnum +
                " by " +
                change.user +
                " on " +
                toReadableDateTime(change.date) +
                " : " +
                change.description.join(" ")
        };
    }
};

export async function showQuickPickForChangelist(resource: vscode.Uri, chnum: string) {
    await qp.showQuickPick("change", resource, chnum);
}

function getOperationIcon(operation: string) {
    switch (operation) {
        case "add":
            return "$(diff-added)";
        case "delete":
        case "move/delete":
        case "purge":
            return "$(diff-removed)";
        case "move/add":
        case "integrate":
        case "branch":
            return "$(diff-renamed)";
        default:
            return "$(diff-modified)";
    }
}

function makeFilePicks(
    uri: vscode.Uri,
    change: DescribedChangelist
): qp.ActionableQuickPickItem[] {
    return [
        {
            label: "Changed files: " + change.affectedFiles.length,
            performAction: () => {
                showQuickPickForChangelist(uri, change.chnum);
            }
        }
    ].concat(
        change.affectedFiles.map<qp.ActionableQuickPickItem>(file => {
            return {
                label:
                    nbsp.repeat(3) +
                    getOperationIcon(file.operation) +
                    " " +
                    file.depotPath +
                    "#" +
                    file.revision,
                performAction: () => {
                    const thisUri = PerforceUri.fromDepotPath(
                        PerforceUri.getUsableWorkspace(uri) ?? uri,
                        file.depotPath,
                        file.revision
                    );
                    showQuickPickForFile(thisUri);
                }
            };
        })
    );
}

function makeJobPicks(
    uri: vscode.Uri,
    change: DescribedChangelist
): qp.ActionableQuickPickItem[] {
    return [
        {
            label: "Jobs fixed: " + change.fixedJobs.length,
            performAction: () => {
                showQuickPickForChangelist(uri, change.chnum);
            }
        }
    ].concat(
        change.fixedJobs.map<qp.ActionableQuickPickItem>(job => {
            return {
                label: nbsp.repeat(3) + "$(tools) " + job.id,
                description: job.description.join(" "),
                performAction: () => {
                    showQuickPickForChangelist(uri, change.chnum);
                }
            };
        })
    );
}
