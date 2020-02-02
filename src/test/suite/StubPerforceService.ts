import * as sinon from "sinon";
import * as vscode from "vscode";

import { PerforceService } from "../../PerforceService";
import { Status } from "../../scm/Status";

import * as path from "path";

type PerforceCommand =
    | "login"
    | "info"
    | "changes"
    | "change"
    | "opened"
    | "describe"
    | "open"
    | "shelve"
    | "unshelve"
    | "revert"
    | "fstat"
    | "print";
type PerforceResponseCallback = (err: Error, stdout: string, stderr: string) => void;
type PerforceCommandCallback = (
    service: StubPerforceService,
    resource?: vscode.Uri,
    args?: string,
    directoryOverride?: string,
    input?: string
) => [string, string]; // return [stdout, stderr]

type PerforceResponses = Record<PerforceCommand, PerforceCommandCallback | null>;

const changelistHeader =
    "#  Change:      The change number. 'new' on a new changelist.\n\
#  Date:        The date this specification was last modified.\n\
#  Client:      The client on which the changelist was created.  Read-only.\n\
#  User:        The user who created the changelist.\n\
#  Status:      Either 'pending' or 'submitted'. Read-only.\n\
#  Type:        Either 'public' or 'restricted'. Default is 'public'.\n\
#  Description: Comments about the changelist.  Required.\n\
#  ImportedBy:  The user who fetched or pushed this change to this server.\n\
#  Identity:    Identifier for this change.\n\
#  Jobs:        What opened jobs are to be closed by this changelist.\n\
#               You may delete jobs from this list.  (New changelists only.)\n\
#  Stream:      What opened stream is to be added to this changelist.\n\
#               You may remove an opened stream from this list.\n\
#  Files:       What opened files from the default changelist are to be added\n\
#               to this changelist.  You may delete files from this list.\n\
#               (New changelists only.)\n\
";

interface StubChangelist {
    chnum: string;
    description: string;
    submitted?: boolean;
    files: StubFile[];
    shelvedFiles?: StubFile[];
    behaviours?: StubChangelistBehaviours;
}

export interface StubFile {
    localFile?: vscode.Uri; // may be undefined where shelved for add and no local file
    depotPath: string;
    depotRevision: number;
    behaviours?: StubFileBehaviours;
    operation?: Status;
    fileType?: string;
    resolveFromDepotPath?: string;
}

/**
 * Used to override / provide behaviour for a specific changelist or file
 * NOTE That the base response function must support this by parsing for the specified
 * changelist / file and calling the override function instead - this will not necessarily
 * work for all commands
 */
type StubBehaviours = Partial<PerforceResponses>;
type StubFileBehaviours = Exclude<StubBehaviours, "login" | "info" | "describe">;
type StubChangelistBehaviours = Exclude<
    StubBehaviours,
    "login" | "info" | "open" | "print"
>;

function stdout(out: string): [string, string] {
    return [out, ""];
}

function stderr(err: string): [string, string] {
    return ["", err];
}

function joinStds(stds: [string, string][], joinWith: string): [string, string] {
    // only join non-empty values
    const outs = stds
        .map(std => std[0])
        .filter(out => !!out)
        .join(joinWith);
    const errs = stds
        .map(std => std[1])
        .filter(out => !!out)
        .join(joinWith);

    return [outs, errs];
}

export function returnStdOut(out: string) {
    return () => stdout(out);
}

export function returnStdErr(err: string) {
    return () => stderr(err);
}

function getDepotPathAndOp(f: StubFile, withHyphen: boolean) {
    return (
        f.depotPath +
        "#" +
        f.depotRevision +
        " " +
        (withHyphen ? "- " : "") +
        getStatusText(f.operation ?? Status.EDIT)
    );
}

function getStatusText(status: Status): string {
    switch (status) {
        case Status.ADD:
            return "add";
        case Status.ARCHIVE:
            return "archive";
        case Status.BRANCH:
            return "branch";
        case Status.DELETE:
            return "delete";
        case Status.EDIT:
            return "edit";
        case Status.IMPORT:
            return "import";
        case Status.INTEGRATE:
            return "integrate";
        case Status.LOCK:
            return "lock";
        case Status.MOVE_ADD:
            return "move/add";
        case Status.MOVE_DELETE:
            return "move/delete";
        case Status.PURGE:
            return "purge";
        case Status.UNKNOWN:
            return "???";
    }
}

export const makeResponses = (
    responses?: Partial<PerforceResponses>,
    from?: PerforceResponses
) => {
    const ret: PerforceResponses = from
        ? from
        : {
              login: returnStdOut(
                  "'login' not necessary, no password set for this user."
              ),
              info: (service, resource) => {
                  const ret =
                      "User name: user\n" +
                      "Client name: cli\n" +
                      "Client host: localhost\n" +
                      "Client root: " +
                      resource.fsPath +
                      "\n" +
                      "Current directory: " +
                      resource.fsPath +
                      "\n" +
                      "Peer address: 127.0.0.1:54954\n" +
                      "Client address: 127.0.0.1\n" +
                      "Server address: kubernetes.docker.internal:1666\n" +
                      "Server root: C:Program FilesPerforceServer\n" +
                      "Server date: 2019/12/30 15:22:41 +0000 GMT Standard Time\n" +
                      "Server uptime: 16:09:09\n" +
                      "Server version: P4D/NTX64/2019.1/1876401 (2019/10/30)\n" +
                      "Server license: none\n" +
                      "Case Handling: insensitive\n";

                  return stdout(ret);
              },
              changes: service => {
                  const ret = service.changelists
                      .filter(c => !c.submitted && c.chnum !== "default")
                      .map(
                          c =>
                              `Change ${c.chnum} on 2019/12/25 by user@cli *pending* '${c.description}'`
                      )
                      .join("\n");
                  return stdout(ret);
              },
              change: (service, _resource, args, _directoryOverride, input) => {
                  if (args.startsWith("-o")) {
                      const change = args.split(" ")[1] || "default";
                      const changelist = service.changelists.find(
                          c => c.chnum === change
                      );
                      let ret = changelistHeader;
                      ret += "\n\n";
                      ret +=
                          "Change:\t" +
                          (change === "default" ? "new" : changelist.chnum) +
                          "\n\n";

                      ret += "Client:\tcli\n\n";
                      ret += "User:\tuser\n\n";
                      ret +=
                          "Status:\t" +
                          (change === "default" ? "new" : "pending") +
                          "\n\n";
                      ret +=
                          "Description:\n\t" +
                          (change === "default"
                              ? "<enter description here>"
                              : changelist.description) +
                          "\n\n";

                      if (changelist.files.length > 0) {
                          ret +=
                              "Files:\n\t" +
                              changelist.files
                                  .map(
                                      file =>
                                          file.depotPath +
                                          "\t# " +
                                          getStatusText(file.operation ?? Status.EDIT)
                                  )
                                  .join("\n\t");
                      }
                      console.log(ret);
                      return stdout(ret);
                  } else if (args.startsWith("-i")) {
                      service.lastChangeInput = input.split("\n\n").reduce((all, cur) => {
                          if (!cur.startsWith("#")) {
                              const colPos = cur.indexOf(":");
                              all[cur.slice(0, colPos)] = cur.slice(colPos + 1);
                          }
                          return all;
                      }, {});
                      // not very accurate - doesn't account for updated, or the number of files included
                      return stdout("Change 99 created.");
                  } else {
                      throw new Error("'change' args " + args + " not supported");
                  }
              },
              opened: (service, resource, args) => {
                  if (args) {
                      throw new Error("'opened' with args not implemented");
                  } else {
                      const ret = service.changelists
                          .filter(c => !c.submitted)
                          .map(c => {
                              return c.files
                                  .map(
                                      f =>
                                          getDepotPathAndOp(f, true) +
                                          (c.chnum === "default"
                                              ? " default change"
                                              : " change " + c.chnum) +
                                          " (" +
                                          (f.fileType ?? "text") +
                                          ")"
                                  )
                                  .join("\n");
                          })
                          .join("\n");

                      if (!ret) {
                          return stderr("no open files (not a real error - ignore)");
                      }

                      return stdout(ret);
                  }
              },
              describe: (service, resource, args, ...rest) => {
                  const [, ...chnums] = args.split(" ");
                  const allStds = chnums.map(chnum => {
                      const c = service.changelists.find(c => c.chnum === chnum);
                      if (c && c.behaviours?.describe) {
                          return c.behaviours.describe(service, resource, args, ...rest);
                      } else if (c) {
                          const pend = c.submitted ? " *pending*" : "";
                          let ret =
                              "Change " +
                              chnum +
                              " by user@cli on 2019/12/25 10:36:29" +
                              pend +
                              "\n\n" +
                              "       " +
                              c.description +
                              "\n\n" +
                              (c.submitted
                                  ? "Affected files ...\n"
                                  : "Shelved files ...\n\n");

                          if (c.shelvedFiles) {
                              ret += c.shelvedFiles
                                  .map(f => "... " + getDepotPathAndOp(f, false))
                                  .join("\n");
                          }
                          //... //depot/TestArea/doc3.txt#1 add
                          //... //depot/TestArea/hmm#1 add
                          //... //depot/TestArea/My initial text document.txt#2 edit
                          //... //depot/TestArea/my next document.txt#1 delete
                          return stdout(ret);
                      } else {
                          return stderr(c + " - no such changelist");
                      }
                  });

                  return joinStds(allStds, "\n\n");
              },
              open: () => {
                  return stdout("open not implemented");
              },
              shelve: (service, ...rest) => {
                  const ret = service.runChangelistBehaviour("shelve", "c", ...rest);
                  return ret ?? stdout("shelve not implemented");
              },
              unshelve: (service, ...rest) => {
                  const ret = service.runChangelistBehaviour("unshelve", "s", ...rest);
                  return ret ?? stdout("unshelve not implemented");
              },
              revert: (service, ...rest) => {
                  const ret = service.runChangelistBehaviour("revert", "c", ...rest);
                  return ret ?? stdout("revert not implemented");
              },
              fstat: (service, resource, args) => {
                  const [, ...files] = args.split(" ");
                  // remove quotes
                  const fs = files.map(f => service.getFstatOutput(f.slice(1, -1)));
                  const stdout: string[] = [];
                  const stderr: string[] = [];
                  fs.forEach((text, i) => {
                      if (text !== undefined) {
                          stdout.push(text);
                      } else {
                          stderr.push(files[i] + " - no such file(s).");
                      }
                  });
                  return [stdout.join("\n\n"), stderr.join("\n\n")];
              },
              print: returnStdOut("print not implemented")
          };
    if (responses) {
        Object.keys(responses).forEach(key => {
            ret[key] = responses[key];
        });
    }
    return ret;
};

export function getLocalFile(workspace: vscode.Uri, ...relativePath: string[]) {
    return vscode.Uri.file(path.resolve(workspace.fsPath, ...relativePath));
}

export class StubPerforceService {
    public changelists: StubChangelist[];
    public lastChangeInput: {};

    constructor(private _responses?: PerforceResponses) {
        this.changelists = [];
        if (!_responses) {
            this._responses = makeResponses();
        }
    }

    setResponse(command: PerforceCommand, response: PerforceCommandCallback | null) {
        this._responses[command] = response;
    }

    with(responses: Partial<PerforceResponses>) {
        const res: PerforceResponses = makeResponses(responses, this._responses);
        return new StubPerforceService(res);
    }

    stubExecute() {
        return sinon.stub(PerforceService, "execute").callsFake(this.execute.bind(this));
    }

    runChangelistBehaviour(
        command: string,
        identifier: string,
        resource: vscode.Uri,
        args?: string,
        directoryOverride?: string,
        input?: string
    ): [string, string] | undefined {
        const re = new RegExp(`-${identifier} (\\w*)`);
        const matches = new RegExp(re).exec(args);
        const chnum = matches?.[1];
        if (chnum) {
            const c = this.getChangelist(chnum);
            if (c?.behaviours?.[command]) {
                return c.behaviours[command](
                    this,
                    resource,
                    args,
                    directoryOverride,
                    input
                );
            }
        }
        return undefined;
    }

    execute(
        resource: vscode.Uri,
        command: string,
        responseCallback: PerforceResponseCallback,
        args?: string,
        directoryOverride?: string,
        input?: string
    ) {
        const [cmd, ...firstArgs] = command.split(" ");
        const allArgs =
            firstArgs?.length > 0 ? firstArgs.join(" ") + (args ? " " + args : "") : args;
        const func = this._responses[cmd];
        if (!func) {
            throw new Error("No stub for perforce command: " + cmd);
        }
        const ret = func(this, resource, allArgs, directoryOverride, input);
        setImmediate(() => {
            responseCallback(undefined, ret[0], ret[1]);
        });
    }

    getChangelist(chnum: string) {
        return this.changelists.find(c => c.chnum === chnum);
    }

    getFstatOutput(depotPath: string): string | undefined {
        const cl: StubChangelist = this.changelists.find(
            c =>
                c.files.find(file => file.depotPath === depotPath) ||
                c.shelvedFiles?.find(file => file.depotPath === depotPath)
        );
        const pendingFile = cl?.files.find(file => file.depotPath === depotPath);
        const shelvedFile = cl?.files.find(file => file.depotPath === depotPath);

        if (pendingFile || shelvedFile) {
            const props = {
                depotFile: depotPath,
                clientFile:
                    pendingFile?.localFile.fsPath ?? shelvedFile?.localFile.fsPath,
                isMapped: true,
                headType: pendingFile?.fileType ?? shelvedFile?.fileType ?? "text",
                action: pendingFile
                    ? getStatusText(pendingFile.operation ?? Status.EDIT)
                    : false,
                change: pendingFile ? cl.chnum : false,
                resolveFromFile0:
                    pendingFile?.resolveFromDepotPath ?? shelvedFile?.resolveFromDepotPath
            };
            return Object.keys(props)
                .filter(prop => props[prop] !== undefined && props[prop] !== false)
                .map(prop => {
                    if (typeof props[prop] === "string") {
                        return `... ${prop} ${props[prop]}`;
                    } else {
                        return `... ${prop}`;
                    }
                })
                .join("\n");
        }
    }
}
