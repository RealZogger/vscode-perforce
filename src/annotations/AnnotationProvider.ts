import * as vscode from "vscode";
import * as p4 from "../api/PerforceApi";

import { isTruthy } from "../api/CommandUtils";
import { Utils } from "../Utils";
import * as md from "./MarkdownGenerator";
import * as ColumnFormatter from "./ColumnFormatter";
import { Display } from "../Display";

const nbsp = "\xa0";

type DecoratedChange = {
    chnum: string;
    decoration: vscode.DecorationOptions;
};

const normalDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    before: {
        margin: "0 1.75em 0 0"
    }
});

const highlightedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("perforce.lineHighlightBackgroundColor"),
    overviewRulerColor: new vscode.ThemeColor("perforce.lineHighlightOverviewRulerColor"),
    overviewRulerLane: vscode.OverviewRulerLane.Left
});

class AnnotationProvider {
    private static _annotationsByUri: Map<vscode.Uri, AnnotationProvider>;

    private _subscriptions: vscode.Disposable[];
    private _editor: vscode.TextEditor | undefined;
    private _p4Uri: vscode.Uri;
    private _decorationsByChnum: DecoratedChange[];

    private constructor(
        private _doc: vscode.Uri,
        private _annotations: (p4.Annotation | undefined)[],
        private _decorations: vscode.DecorationOptions[]
    ) {
        this._p4Uri = Utils.makePerforceDocUri(_doc, "print", "-q");
        this._subscriptions = [];
        this._decorationsByChnum = this.mapToChnums();

        this._subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(this.onEditorChanged.bind(this))
        );

        this._subscriptions.push(
            vscode.window.onDidChangeTextEditorSelection(
                this.onSelectionChanged.bind(this)
            )
        );

        this._subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(
                this.checkStillOpen.bind(this),
                this._subscriptions
            )
        );

        this.loadEditor();
    }

    private mapToChnums(): DecoratedChange[] {
        return this._annotations
            .map((ann, i) => {
                return ann?.revisionOrChnum
                    ? {
                          chnum: ann.revisionOrChnum,
                          decoration: this._decorations[i]
                      }
                    : undefined;
            })
            .filter(isTruthy);
    }

    private async loadEditor() {
        this._editor = await vscode.window.showTextDocument(this._p4Uri);
        this.applyBaseDecorations();
        // don't apply highlights until a line is selected
    }

    private applyBaseDecorations() {
        if (!this._editor) {
            return;
        }
        this._editor.setDecorations(normalDecoration, this._decorations);
    }

    private applyHighlightDecorations() {
        if (!this._editor) {
            return;
        }
        const line = this._editor.selection.start.line;
        const ann = this._annotations[line];
        const chnum = ann?.revisionOrChnum;

        const highlighted = this._decorationsByChnum
            .filter(dec => dec.chnum === chnum)
            .map(dec => dec.decoration.range);

        this._editor.setDecorations(highlightedDecoration, highlighted);
    }

    private clearDecorations() {
        this._editor?.setDecorations(normalDecoration, []);
        this._editor?.setDecorations(highlightedDecoration, []);
    }

    private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent) {
        if (this._editor && event.textEditor === this._editor) {
            this.applyHighlightDecorations();
        }
    }

    private onEditorChanged() {
        this.checkStillOpen();
        if (!vscode.window.activeTextEditor?.document) {
            return;
        }
        if (vscode.window.activeTextEditor?.document === this._editor?.document) {
            // TODO - this bit is weird - the same document is opened in a new editor.
            // Does this mean we could have multiple annotation providers lying around? need to investigate
            this._editor = vscode.window.activeTextEditor;
            this.applyBaseDecorations();
            this.applyHighlightDecorations();
        }
    }

    private checkStillOpen() {
        if (
            this._editor &&
            !vscode.workspace.textDocuments.includes(this._editor.document)
        ) {
            Display.channel.appendLine("Document closed: " + this._editor.document.uri);
            this.dispose();
        }
    }

    dispose() {
        this.clearDecorations();
        // TODO bit ugly for the class to know about the static map
        if (AnnotationProvider._annotationsByUri.get(this._doc) === this) {
            AnnotationProvider._annotationsByUri.delete(this._doc);
        }
        this._decorationsByChnum = [];
        this._subscriptions.forEach(d => d.dispose());
    }

    static async annotate(uri: vscode.Uri, swarmHost?: string) {
        if (!this._annotationsByUri) {
            this._annotationsByUri = new Map();
        }
        const existing = this._annotationsByUri.get(uri);
        if (existing) {
            // TODO - this gets rid of the existing one and gets the new perforce details instead
            // is this actually useful, or should we just return the existing one?
            existing.dispose();
        }

        const followBranches = vscode.workspace
            .getConfiguration("perforce")
            .get("annotate.followBranches", false);

        const underlying = getUnderlyingUri(uri);
        const annotationsPromise = p4.annotate(underlying, {
            file: uri,
            outputChangelist: true,
            followBranches
        });

        const logPromise = p4.getFileHistory(underlying, { file: uri, followBranches });

        const [annotations, log] = await Promise.all([annotationsPromise, logPromise]);
        const decorations = getDecorations(underlying, swarmHost, annotations, log);

        const provider = new AnnotationProvider(uri, annotations, decorations);
        this._annotationsByUri.set(uri, provider);

        return provider;
    }
}

function getUnderlyingUri(uri: vscode.Uri) {
    const decoded = Utils.decodeUriQuery(uri.query);
    return decoded.workspace ? vscode.Uri.file(decoded.workspace as string) : uri;
}

function makeHoverMessage(
    underlying: vscode.Uri,
    change: p4.FileLogItem,
    latestChange: p4.FileLogItem,
    prevChange?: p4.FileLogItem,
    swarmHost?: string
): vscode.MarkdownString {
    const links = md.makeAllLinks(
        underlying,
        change,
        latestChange,
        prevChange,
        swarmHost
    );

    const markdown = new vscode.MarkdownString(
        md.makeUserAndDateSummary(change) +
            "\n\n" +
            links +
            "\n\n" +
            md.convertToMarkdown(change.description)
    );
    markdown.isTrusted = true;

    return markdown;
}

function makeDecoration(
    lineNumber: number,
    revisionsAgo: number,
    totalRevisions: number,
    isTop: boolean,
    summaryText: string,
    hoverMessage: vscode.MarkdownString,
    foregroundColor: vscode.ThemeColor,
    backgroundColor: vscode.ThemeColor,
    columnWidth: number
) {
    const alphaStep = 1 / Math.min(Math.max(1, totalRevisions), 10);
    const alpha = Math.max(1 - alphaStep * revisionsAgo, 0);
    const color = `rgba(246, 106, 10, ${alpha})`;

    const overline = isTop ? "overline solid rgba(0, 0, 0, 0.2)" : undefined;

    // this is weird, but it works
    const before: vscode.ThemableDecorationRenderOptions &
        vscode.ThemableDecorationAttachmentRenderOptions = {
        contentText: nbsp + summaryText,
        color: foregroundColor,
        width: columnWidth + 2 + "ch",
        backgroundColor,
        border: "solid " + color,
        textDecoration: overline,
        borderWidth: "0px 2px 0px 0px"
    };
    const renderOptions: vscode.DecorationInstanceRenderOptions = { before };

    return {
        range: new vscode.Range(lineNumber, 0, lineNumber, 0),
        hoverMessage,
        renderOptions
    };
}

function getDecorations(
    underlying: vscode.Uri,
    swarmHost: string | undefined,
    annotations: (p4.Annotation | undefined)[],
    log: p4.FileLogItem[]
): vscode.DecorationOptions[] {
    const backgroundColor = new vscode.ThemeColor("perforce.gutterBackgroundColor");
    const foregroundColor = new vscode.ThemeColor("perforce.gutterForegroundColor");

    const latestChange = log[0];

    const columnOptions = ColumnFormatter.parseColumns(
        vscode.workspace
            .getConfiguration("perforce")
            .get<string[]>("annotate.gutterColumns", ["{#}revision|3"])
    );

    const columnWidth = ColumnFormatter.calculateTotalWidth(columnOptions);

    return annotations
        .map((a, i) => {
            const usePrevious =
                i > 0 && a?.revisionOrChnum === annotations[i - 1]?.revisionOrChnum;
            const annotation = usePrevious ? annotations[i - 1] : a;

            if (!annotation) {
                return;
            }

            const changeIndex = log.findIndex(
                l => l.chnum === annotation.revisionOrChnum
            );
            if (changeIndex < 0) {
                Display.showImportantError(
                    "Error during annotation - could not read change information for " +
                        annotation.revisionOrChnum
                );
                throw new Error(
                    "Could not find change info for " + annotation.revisionOrChnum
                );
            }
            const revisionsAgo = changeIndex;

            const change = log[changeIndex];
            const prevChange = log[changeIndex + 1];

            const summary = usePrevious
                ? nbsp
                : change
                ? ColumnFormatter.makeSummaryText(change, latestChange, columnOptions)
                : "Unknown!";

            const hoverMessage = makeHoverMessage(
                underlying,
                change,
                latestChange,
                prevChange,
                swarmHost
            );

            return makeDecoration(
                i,
                revisionsAgo,
                log.length,
                !usePrevious,
                summary,
                hoverMessage,
                foregroundColor,
                backgroundColor,
                columnWidth
            );
        })
        .filter(isTruthy);
}

export async function annotate(uri: vscode.Uri, swarmHost?: string) {
    return AnnotationProvider.annotate(uri, swarmHost);
}
