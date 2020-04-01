import * as vscode from "vscode";
import { pipe } from "@arrows/composition";
import {
    concatIfOutputIsDefined,
    flagMapper,
    makeSimpleCommand,
    asyncOuputHandler,
    splitIntoChunks,
    mergeAll,
    extractSection,
    sectionArrayBy
} from "./CommandUtils";
import {
    FstatInfo,
    PerforceFile,
    ChangeInfo,
    FixedJob,
    RawField,
    ChangeSpec
} from "./CommonTypes";
import * as PerforceUri from "../PerforceUri";
import { isTruthy } from "../TsUtils";

//const prepareOutput = (value: string) => value.trim();
const removeLeadingNewline = (value: string) => value.replace(/^\r*?\n/, "");
const splitIntoLines = (value: string) => value.split(/\r*?\n/);
const splitIntoSections = (str: string) => str.split(/\r*?\n\r*?\n/);
const removeIndent = (lines: string[]) => lines.map(line => line.replace(/^\t/, ""));

//#region Changelists

const parseRawField = pipe(removeLeadingNewline, splitIntoLines, removeIndent);

function parseRawFields(parts: string[]): RawField[] {
    return parts.map(field => {
        const colPos = field.indexOf(":");
        const name = field.slice(0, colPos);
        const value = parseRawField(field.slice(colPos + 2));
        return { name, value };
    });
}

const getBasicField = (fields: RawField[], field: string) =>
    fields.find(i => i.name === field)?.value;

const excludeNonFields = (parts: string[]) =>
    parts.filter(part => !part.startsWith("#") && part !== "");

function mapToChangeFields(rawFields: RawField[]): ChangeSpec {
    return {
        change: getBasicField(rawFields, "Change")?.[0].trim(),
        description: getBasicField(rawFields, "Description")?.join("\n"),
        files: getBasicField(rawFields, "Files")?.map(file => {
            const endOfFileStr = file.indexOf("#");
            return {
                depotPath: file.slice(0, endOfFileStr).trim(),
                action: file.slice(endOfFileStr + 2)
            };
        }),
        rawFields
    };
}

const parseChangeSpec = pipe(
    splitIntoSections,
    excludeNonFields,
    parseRawFields,
    mapToChangeFields
);

const getChangeAsRawField = (spec: ChangeSpec) =>
    spec.change ? { name: "Change", value: [spec.change] } : undefined;

const getDescriptionAsRawField = (spec: ChangeSpec) =>
    spec.description
        ? { name: "Description", value: splitIntoLines(spec.description) }
        : undefined;

const getFilesAsRawField = (spec: ChangeSpec) =>
    spec.files
        ? {
              name: "Files",
              value: spec.files.map(file => file.depotPath + "\t# " + file.action)
          }
        : undefined;

function getDefinedSpecFields(spec: ChangeSpec): RawField[] {
    return concatIfOutputIsDefined(
        getChangeAsRawField,
        getDescriptionAsRawField,
        getFilesAsRawField
    )(spec);
}

export type ChangeSpecOptions = {
    existingChangelist?: string;
};

const changeFlags = flagMapper<ChangeSpecOptions>([], "existingChangelist", ["-o"], {
    lastArgIsFormattedArray: true
});

const outputChange = makeSimpleCommand("change", changeFlags);

export const getChangeSpec = asyncOuputHandler(outputChange, parseChangeSpec);

export type InputChangeSpecOptions = {
    spec: ChangeSpec;
};

export type CreatedChangelist = {
    rawOutput: string;
    chnum?: string;
};

function parseCreatedChangelist(createdStr: string): CreatedChangelist {
    const matches = /Change\s(\d+)\s/.exec(createdStr);
    return {
        rawOutput: createdStr,
        chnum: matches?.[1]
    };
}

const inputChange = makeSimpleCommand(
    "change",
    () => ["-i"],
    (options: InputChangeSpecOptions) => {
        return {
            input:
                getDefinedSpecFields(options.spec)
                    .concat(
                        options.spec.rawFields.filter(
                            field =>
                                !options.spec[
                                    field.name.toLowerCase() as keyof ChangeSpec
                                ]
                        )
                    )
                    .map(field => field.name + ":\t" + field.value.join("\n\t"))
                    .join("\n\n") + "\n\n" // perforce doesn't like an empty raw field on the end without newlines
        };
    }
);

export const inputChangeSpec = asyncOuputHandler(inputChange, parseCreatedChangelist);

export type DeleteChangelistOptions = {
    chnum: string;
};

const deleteChangelistFlags = flagMapper<DeleteChangelistOptions>([["d", "chnum"]]);

export const deleteChangelist = makeSimpleCommand("change", deleteChangelistFlags);

//#endregion

//#region FSTAT

export interface FstatOptions {
    depotPaths: string[];
    chnum?: string;
    limitToShelved?: boolean;
    outputPendingRecord?: boolean;
}

function parseZTagField(field: string) {
    // examples:
    // ... depotFile //depot/testArea/stuff
    // ... mapped
    const matches = /[.]{3} (\w+)[ ]*(.+)?/.exec(field);
    if (matches) {
        return { [matches[1]]: matches[2] ? matches[2] : "true" } as Partial<FstatInfo>;
    }
}

function parseZTagBlock(block: string) {
    return splitIntoLines(block)
        .map(parseZTagField)
        .filter(isTruthy);
}

function parseFstatSection(file: string) {
    return mergeAll({ depotFile: "" }, ...parseZTagBlock(file)) as FstatInfo;
}

function parseFstatOutput(expectedFiles: string[], fstatOutput: string) {
    const all = splitIntoSections(fstatOutput.trim()).map(file =>
        parseFstatSection(file)
    );
    return expectedFiles.map(file => all.find(fs => fs["depotFile"] === file));
}

const fstatFlags = flagMapper<FstatOptions>(
    [
        ["e", "chnum"],
        ["Or", "outputPendingRecord"],
        ["Rs", "limitToShelved"]
    ],
    "depotPaths"
);

const fstatBasic = makeSimpleCommand("fstat", fstatFlags).ignoringStdErr;

export async function getFstatInfo(resource: vscode.Uri, options: FstatOptions) {
    const chunks = splitIntoChunks(options.depotPaths);
    const promises = chunks.map(paths =>
        fstatBasic(resource, { ...options, ...{ depotPaths: paths } })
    );

    const fstats = await Promise.all(promises);
    return fstats.flatMap((output, i) => parseFstatOutput(chunks[i], output));
}

//#endregion

export type OpenedFileOptions = { chnum?: string; files?: PerforceFile[] };

export type OpenedFile = {
    depotPath: string;
    revision: string;
    chnum: string;
    operation: string;
    filetype: string;
    message: string;
};

export enum UnopenedFileReason {
    NOT_OPENED,
    NOT_IN_ROOT
}

export type UnopenedFile = {
    filePath: string;
    reason: UnopenedFileReason;
    message: string;
};

function parseOpenFile(line: string): OpenedFile | undefined {
    const matches = /(.+)#(\d+)\s-\s([\w\/]+)\s(default\schange|change\s\d+)\s\(([\w\+]+)\)/.exec(
        line
    );
    if (matches) {
        const [message, depotPath, revision, operation, chnumStr, filetype] = matches;
        const chnum = chnumStr.startsWith("change") ? chnumStr.split(" ")[1] : "default";
        return { depotPath, revision, operation, chnum, filetype, message };
    }
}

function parseOpenedOutput(output: string): OpenedFile[] {
    // example:
    // //depot/testArea/stuff#1 - edit change 46 (text)
    return splitIntoLines(output.trim())
        .map(parseOpenFile)
        .filter(isTruthy);
}

function parseUnopenFile(line: string): UnopenedFile | undefined {
    // example:
    // TestArea/newFile.txt - file(s) not opened on this client.
    // or
    // Path 'C:/Users/zogge\db.desc' is not under client's root 'c:\Users\zogge\Perforce\default'.
    const matches = /(?:((.+)\s-\sfile\(s\)\snot\sopened.*)|(Path\s'(.+)'\sis\snot\sunder.*))/.exec(
        line
    );

    if (matches) {
        const [, unopenMessage, unopenPath, noRootMessage, noRootPath] = matches;
        const message = unopenMessage || noRootMessage;
        const filePath = unopenMessage ? unopenPath : noRootPath;
        const reason = unopenMessage
            ? UnopenedFileReason.NOT_OPENED
            : UnopenedFileReason.NOT_IN_ROOT;
        return { message, filePath, reason };
    }
}

function parseOpenedErrors(output: string): UnopenedFile[] {
    return splitIntoLines(output.trim())
        .map(parseUnopenFile)
        .filter(isTruthy);
}

const openedFlags = flagMapper<OpenedFileOptions>([["c", "chnum"]], "files", [], {
    ignoreRevisionFragments: true
});

const opened = makeSimpleCommand("opened", openedFlags);

/**
 * Gets opened files, ignoring error messages about unopened or out of workspace files
 * @param resource the resource to determine where / how to run the command
 * @param options options for the command
 */
export async function getOpenedFiles(resource: vscode.Uri, options: OpenedFileOptions) {
    const output = await opened.ignoringAndHidingStdErr(resource, options);
    return parseOpenedOutput(output);
}

export type OpenedFileDetails = {
    open: OpenedFile[];
    unopen: UnopenedFile[];
};

/**
 * Gets opened files, and if files are specified in the options, the files that are not opened or are out of workspace from that list
 * @param resource the resource to determine where / how to run the command
 * @param options options for the command
 */
export async function getOpenedFileDetails(
    resource: vscode.Uri,
    options: OpenedFileOptions
): Promise<OpenedFileDetails> {
    const [stdout, stderr] = await opened.raw(resource, options);
    const open = parseOpenedOutput(stdout);
    const unopen = parseOpenedErrors(stderr);
    return { open, unopen };
}

export type SubmitChangelistOptions = {
    chnum?: string;
    description?: string;
    file?: PerforceFile;
};

const submitFlags = flagMapper<SubmitChangelistOptions>(
    [
        ["c", "chnum"],
        ["d", "description"]
    ],
    "file"
);

const submitChangelistCommand = makeSimpleCommand("submit", submitFlags);

function parseSubmitOutput(output: string) {
    const matches = /Change (\d+) submitted/.exec(output);
    return {
        rawOutput: output,
        chnum: matches?.[1]
    };
}

export const submitChangelist = asyncOuputHandler(
    submitChangelistCommand,
    parseSubmitOutput
);

export interface RevertOptions {
    paths: PerforceFile[];
    chnum?: string;
    unchanged?: boolean;
}

const revertFlags = flagMapper<RevertOptions>(
    [
        ["a", "unchanged"],
        ["c", "chnum"]
    ],
    "paths"
);

export const revert = makeSimpleCommand("revert", revertFlags);

export interface DeleteOptions {
    chnum?: string;
    paths: PerforceFile[];
}

const deleteFlags = flagMapper<DeleteOptions>([["c", "chnum"]], "paths");

export const del = makeSimpleCommand("delete", deleteFlags);

//#region Shelving

export interface ShelveOptions {
    chnum?: string;
    force?: boolean;
    delete?: boolean;
    paths?: PerforceFile[];
}

const shelveFlags = flagMapper<ShelveOptions>(
    [
        ["f", "force"],
        ["d", "delete"],
        ["c", "chnum"]
    ],
    "paths"
);

export const shelve = makeSimpleCommand("shelve", shelveFlags);

export interface UnshelveOptions {
    shelvedChnum: string;
    toChnum?: string;
    force?: boolean;
    paths?: PerforceFile[];
}

const unshelveFlags = flagMapper<UnshelveOptions>(
    [
        ["f", "force"],
        ["s", "shelvedChnum"],
        ["c", "toChnum"]
    ],
    "paths"
);

export const unshelve = makeSimpleCommand("unshelve", unshelveFlags);

//#endregion

export interface FixJobOptions {
    chnum: string;
    jobId: string;
    removeFix?: boolean;
}

const fixJobFlags = flagMapper<FixJobOptions>(
    [
        ["c", "chnum"],
        ["d", "removeFix"]
    ],
    "jobId"
);

export const fixJob = makeSimpleCommand("fix", fixJobFlags);

export interface ReopenOptions {
    chnum: string;
    files: PerforceFile[];
}

const reopenFlags = flagMapper<ReopenOptions>([["c", "chnum"]], "files");

export const reopenFiles = makeSimpleCommand("reopen", reopenFlags);

export interface SyncOptions {
    files?: PerforceFile[];
}

const syncFlags = flagMapper<SyncOptions>([], "files");

export const sync = makeSimpleCommand("sync", syncFlags);

export enum ChangelistStatus {
    PENDING = "pending",
    SHELVED = "shelved",
    SUBMITTED = "submitted"
}
export interface ChangesOptions {
    client?: string;
    status?: ChangelistStatus;
}

const changes = makeSimpleCommand(
    "changes",
    flagMapper<ChangesOptions>([
        ["c", "client"],
        ["s", "status"]
    ])
);

function parseChangelistDescription(value: string): ChangeInfo | undefined {
    // example:
    // Change 45 on 2020/02/15 by super@matto 'a new changelist with a much lo'

    // with -t flag
    // Change 45 on 2020/02/15 18:48:43 by super@matto 'a new changelist with a much lo'
    const matches = /Change\s(\d+)\son\s(.+)\sby\s(.+)@(.+?)\s(?:\*(.+)\*\s)?\'(.*)\'/.exec(
        value
    );

    if (matches) {
        const [, chnum, date, user, client, status, description] = matches;
        return { chnum, date, user, client, status, description };
    }
}

function parseChangesOutput(output: string): ChangeInfo[] {
    return output
        .split(/\r?\n/)
        .map(parseChangelistDescription)
        .filter(isTruthy);
}

export const getChangelists = asyncOuputHandler(changes, parseChangesOutput);

export interface DescribeOptions {
    chnums: string[];
    omitDiffs?: boolean;
    shelved?: boolean;
}

const describeFlags = flagMapper<DescribeOptions>(
    [
        ["S", "shelved"],
        ["s", "omitDiffs"]
    ],
    "chnums",
    [],
    { lastArgIsFormattedArray: true }
);

const describe = makeSimpleCommand("describe", describeFlags);

export interface GetShelvedOptions {
    chnums: string[];
}

export type ShelvedChangeInfo = { chnum: number; paths: string[] };

function parseShelvedDescribeOuput(output: string): ShelvedChangeInfo[] {
    const allLines = splitIntoLines(output.trim());

    const changelists = sectionArrayBy(allLines, line => /^Change \d+ by/.test(line));

    return changelists
        .map(section => {
            const matches = section
                .slice(1)
                .map(line => /(\.+)\ (.*)#(.*) (.*)/.exec(line)?.[2])
                .filter(isTruthy);
            return { chnum: parseInt(section[0].split(" ")[1]), paths: matches };
        })
        .filter(isTruthy)
        .filter(c => c.paths.length > 0);
}

export async function getShelvedFiles(
    resource: vscode.Uri,
    options: GetShelvedOptions
): Promise<ShelvedChangeInfo[]> {
    if (options.chnums.length === 0) {
        return [];
    }
    const output = await describe(resource, {
        chnums: options.chnums,
        omitDiffs: true,
        shelved: true
    });
    return parseShelvedDescribeOuput(output);
}

// TODO can this be merged into common handling for describe output?
function parseFixedJobsOutput(output: string): FixedJob[] {
    /**
     * example:
     *
     * Jobs fixed ...
     *
     * job000001 on 2020/02/22 by super *open*
     *
     * \ta job
     * \thooray
     *
     * etc
     * Affected files ...
     */
    const allLines = splitIntoLines(output.trim());
    const subLines = extractSection(
        allLines,
        line => line.startsWith("Jobs fixed ..."),
        line => !line.startsWith("\t") && line.includes("files ...")
    );

    if (subLines) {
        return sectionArrayBy(subLines, line => /^\w*? on/.test(line)).map(job => {
            return {
                id: job[0].split(" ")[0],
                description: job
                    .slice(1)
                    .filter(line => line.startsWith("\t"))
                    .map(line => line.slice(1))
            };
        });
    }
    return [];
}

export interface GetFixedJobsOptions {
    chnum: string;
}

export async function getFixedJobs(resource: vscode.Uri, options: GetFixedJobsOptions) {
    const output = await describe(resource, {
        chnums: [options.chnum],
        omitDiffs: true
    });
    return parseFixedJobsOutput(output);
}

function parseInfo(output: string): Map<string, string> {
    const map = new Map<string, string>();
    const lines = output.trim().split(/\r?\n/);

    for (let i = 0, n = lines.length; i < n; ++i) {
        // Property Name: Property Value
        const matches = /([^:]+): (.+)/.exec(lines[i]);

        if (matches) {
            map.set(matches[1], matches[2]);
        }
    }

    return map;
}

export const info = makeSimpleCommand("info", () => []);

export const getInfo = asyncOuputHandler(info, parseInfo);

export interface HaveFileOptions {
    file: PerforceFile;
}

const haveFileFlags = flagMapper<HaveFileOptions>([], "file", [], {
    ignoreRevisionFragments: true
});

function parseHaveOutput(resource: vscode.Uri, output: string): vscode.Uri | undefined {
    const matches = /^(.+)#(\d+) - .+/.exec(output);

    if (matches) {
        return PerforceUri.fromDepotPath(resource, matches[1], matches[2]);
    }
}

// TODO tidy this up

const haveFileCmd = makeSimpleCommand("have", haveFileFlags);

/**
 * Checks if we `have` a file.
 * @param resource Context for where to run the command
 * @param options Options for the command
 * @returns a perforce URI representing the depot path, revision etc
 */
export async function have(resource: vscode.Uri, options: HaveFileOptions) {
    const output = await haveFileCmd(resource, options);
    return parseHaveOutput(resource, output);
}

// if stdout has any value, we have the file (stderr indicates we don't)
export const haveFile = asyncOuputHandler(haveFileCmd.ignoringAndHidingStdErr, isTruthy);

export type NoOpts = {};

export type LoginOptions = {
    password: string;
};

export const login = makeSimpleCommand(
    "login",
    () => [],
    (options: LoginOptions) => {
        return {
            input: options.password
        };
    }
);

const getLoggedInStatus = makeSimpleCommand<NoOpts>("login", () => ["-s"]);

export async function isLoggedIn(resource: vscode.Uri): Promise<boolean> {
    try {
        await getLoggedInStatus(resource, {});
        return true;
    } catch {
        return false;
    }
}

export const logout = makeSimpleCommand<NoOpts>("logout", () => []);

export interface FilelogOptions {
    file: PerforceFile;
    followBranches?: boolean;
}

const filelogFlags = flagMapper<FilelogOptions>([["i", "followBranches"]], "file", [
    "-l",
    "-t"
]);

const filelog = makeSimpleCommand("filelog", filelogFlags);

function parseDate(dateString: string) {
    // example: 2020/02/15 18:48:43
    // or: 2020/02/15
    const matches = /(\d{4})\/(\d{2})\/(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?/.exec(
        dateString.trim()
    );

    if (matches) {
        const [, year, month, day, hours, minutes, seconds] = matches;

        const hasTime = hours && minutes && seconds;

        return new Date(
            parseInt(year),
            parseInt(month) - 1,
            parseInt(day),
            hasTime ? parseInt(hours) : undefined,
            hasTime ? parseInt(minutes) : undefined,
            hasTime ? parseInt(seconds) : undefined
        );
    }
}

export enum Direction {
    TO,
    FROM
}

export type FileLogIntegration = {
    file: string;
    startRev: string;
    endRev: string;
    operation: string;
    direction: Direction;
};

export type FileLogItem = {
    file: string;
    description: string;
    revision: string;
    chnum: string;
    operation: string;
    date?: Date;
    user: string;
    client: string;
    integrations: FileLogIntegration[];
};

function parseFileLogIntegrations(lines: string[]): FileLogIntegration[] {
    return lines
        .map(line => {
            const matches = /^.{3} .{3} (\S+) (into|from) (.*?)#(\d+)(?:,#(\d+))?$/.exec(
                line
            );
            if (matches) {
                const [, operation, dirString, file, startRev, endRev] = matches;
                const direction = dirString === "into" ? Direction.TO : Direction.FROM;
                return { operation, direction, file, startRev, endRev };
            }
        })
        .filter(isTruthy);
}

function parseFilelogItem(item: string[], file: string): FileLogItem | undefined {
    // example:
    // ... #9 change 43 integrate on 2020/03/29 18:48:43 by zogge@default (text)
    //
    //    integrate from main
    //
    // ... ... copy into //depot/TestArea/newFile.txt#5
    // ... ... edit from //depot/TestArea/newFile.txt#3,#4
    const [header, ...desc] = item;

    const matches = /^\.{3} #(\d+) change (\d+) (\S+) on (.*?) by (.*?)@(.*?) (.*?)$/.exec(
        header
    );
    if (matches) {
        const [, revision, chnum, operation, date, user, client] = matches;
        const description = desc
            .filter(l => l.startsWith("\t"))
            .map(l => l.slice(1))
            .join("\n");
        const integStrings = desc.filter(l => l.startsWith("... ..."));
        const integrations = parseFileLogIntegrations(integStrings);

        return {
            file,
            description,
            revision,
            chnum,
            operation,
            date: parseDate(date),
            user,
            client,
            integrations
        };
    }
}

function parseFileLogFile(lines: string[]) {
    const histories = sectionArrayBy(lines.slice(1), line => line.startsWith("... #"));

    const file = lines[0];

    return histories.map(h => parseFilelogItem(h, file)).filter(isTruthy);
}

function parseFileLogFiles(lines: string[]) {
    const files = sectionArrayBy(lines, line => line.startsWith("//"));

    return files.flatMap(parseFileLogFile);
}

function parseFilelogOutput(output: string) {
    const lines = splitIntoLines(output);

    return parseFileLogFiles(lines);
}

export async function getFileHistory(resource: vscode.Uri, options: FilelogOptions) {
    const output = await filelog(resource, options);
    return parseFilelogOutput(output);
}

export interface AnnotateOptions {
    outputChangelist?: boolean;
    outputUser?: boolean;
    followBranches?: boolean;
    file: PerforceFile;
}

const annotateFlags = flagMapper<AnnotateOptions>(
    [
        ["c", "outputChangelist"],
        ["u", "outputUser"],
        ["i", "followBranches"]
    ],
    "file",
    ["-q"]
);

const annotateCommand = makeSimpleCommand("annotate", annotateFlags);

export type Annotation = {
    line: string;
    revisionOrChnum: string;
    user?: string;
    date?: string;
};

function parseAnnotateOutput(
    output: string,
    withUser?: boolean
): (Annotation | undefined)[] {
    const lines = splitIntoLines(output);
    //examples with / without user:
    // 1: super 2020/01/29 hello this is a file
    // 1: hello this is a file

    const regex = withUser ? /^(\d+): (\S+) (\S+) (.*?)$/ : /^(\d+): (.*?)$/;
    const linePos = withUser ? 4 : 2;

    return lines.map(line => {
        const matches = regex.exec(line);

        if (matches) {
            const revisionOrChnum = matches[1];
            const user = withUser ? matches[2] : undefined;
            const date = withUser ? matches[3] : undefined;
            return {
                line: matches[linePos],
                revisionOrChnum,
                user,
                date
            };
        } else {
            return undefined;
        }
    });
}

export async function annotate(resource: vscode.Uri, options: AnnotateOptions) {
    const output = await annotateCommand(resource, options);
    return parseAnnotateOutput(output, options.outputUser);
}

export interface IntegratedOptions {
    intoOnly?: boolean;
    startingChnum?: string;
    file?: PerforceFile;
}

const integrateFlags = flagMapper<IntegratedOptions>(
    [
        ["s", "startingChnum"],
        ["-into-only", "intoOnly"]
    ],
    "file",
    undefined,
    { ignoreRevisionFragments: true }
);

const integratedCommand = makeSimpleCommand("integrated", integrateFlags)
    .ignoringAndHidingStdErr;

type IntegratedRevision = {
    fromFile: string;
    fromStartRev: string;
    fromEndRev: string;
    operation: string;
    toFile: string;
    toRev: string;
    displayDirection: string;
};

function parseIntegratedRevision(line: string): IntegratedRevision | undefined {
    // example:
    // //depot/branches/branch1/newFile.txt#4,#6 - edit into //depot/branches/branch2/newFile.txt#2
    // //depot/branches/branch1/newFile.txt#1 - branch from //depot/TestArea/newFile.txt#1,#2
    // //depot/branches/branch1/newFile.txt#9 - edit from //depot/TestArea/newFile.txt#3,#4
    // //depot/branches/branch1/newFile.txt#2,#9 - copy into //depot/TestArea/newFile.txt#5

    const matches = /^(.*?)#(\d+)(?:,#(\d+))? - (\S+) (into|from) (.*?)#(\d+)(?:,#(\d+))?$/.exec(
        line
    );

    if (matches) {
        const [
            ,
            leftFile,
            leftStartRev,
            leftEndRev,
            operation,
            direction,
            rightFile,
            rightStartRev,
            rightEndRev
        ] = matches;

        return direction === "from"
            ? {
                  fromFile: rightFile,
                  fromStartRev: rightStartRev,
                  fromEndRev: rightEndRev,
                  operation,
                  toFile: leftFile,
                  toRev: leftStartRev,
                  displayDirection: direction
              }
            : {
                  fromFile: leftFile,
                  fromStartRev: leftStartRev,
                  fromEndRev: leftEndRev,
                  operation,
                  toFile: rightFile,
                  toRev: rightStartRev,
                  displayDirection: direction
              };
    }
}

function parseIntegratedOutput(output: string) {
    return splitIntoLines(output)
        .map(parseIntegratedRevision)
        .filter(isTruthy);
}

export const integrated = asyncOuputHandler(integratedCommand, parseIntegratedOutput);
