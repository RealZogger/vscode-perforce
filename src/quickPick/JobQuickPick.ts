import * as vscode from "vscode";

import * as PerforceUri from "../PerforceUri";
import * as p4 from "../api/PerforceApi";

import * as qp from "./QuickPickProvider";
import { showQuickPickForChangelist } from "./ChangeQuickPick";
import { Job } from "../api/PerforceApi";

const nbsp = "\xa0";

export const jobQuickPickProvider: qp.ActionableQuickPickProvider = {
    provideActions: async (
        resourceOrStr: vscode.Uri | string,
        job: string
    ): Promise<qp.ActionableQuickPick> => {
        const resource = qp.asUri(resourceOrStr);
        const jobInfo = await p4.getJob(resource, { existingJob: job });
        const clipItems = makeClipboardPicks(jobInfo);

        const fixItems = await makeFixesPicks(resource, job);

        const showJobItem = {
            label: "$(file) Show job",
            description: "Open the full job spec in the editor",
            performAction: () => {
                const uri = PerforceUri.forCommand(resource, "job", "-o").with({
                    path: job,
                });
                vscode.window.showTextDocument(uri);
            },
        };

        return {
            items: [...clipItems, showJobItem, ...fixItems],
            placeHolder:
                "Job " +
                jobInfo.job +
                " (" +
                jobInfo.status +
                ") by " +
                jobInfo.user +
                " : " +
                jobInfo.description,
        };
    },
};

export async function showQuickPickForJob(resource: vscode.Uri, job: string) {
    await qp.showQuickPick("job", resource, job);
}

async function makeFixesPicks(
    resource: vscode.Uri,
    job: string
): Promise<qp.ActionableQuickPickItem[]> {
    const fixes = await p4.fixes(resource, { job });
    const described =
        fixes.length > 0
            ? await p4.describe(resource, {
                  omitDiffs: true,
                  chnums: fixes.map((fix) => fix.chnum),
              })
            : [];
    const fixedByItem = {
        label: "Fixed by changelists: " + fixes.length,
    };
    const fixItems = fixes.map((fix) => {
        const change = described.find((d) => d.chnum === fix.chnum);
        return {
            label:
                nbsp.repeat(3) +
                (change?.isPending ? "$(tools) " : "$(check) ") +
                fix.chnum,
            description:
                "$(person) " + fix.user + "@" + fix.client + " $(calendar) " + fix.date,
            performAction: () => {
                showQuickPickForChangelist(resource, fix.chnum);
            },
        };
    });
    return [fixedByItem, ...fixItems];
}

function makeClipboardPicks(jobInfo: Job): qp.ActionableQuickPickItem[] {
    return [
        qp.makeClipPick("job id", jobInfo.job),
        qp.makeClipPick("description", jobInfo.description),
        qp.makeClipPick("user", jobInfo.user),
    ];
}
