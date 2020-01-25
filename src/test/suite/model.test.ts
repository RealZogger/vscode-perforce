import { expect } from "chai";
import * as chai from "chai";
import * as chaiAsPromised from "chai-as-promised";
import * as sinonChai from "sinon-chai";

import * as vscode from "vscode";

import * as sinon from "sinon";
import { IPerforceConfig } from "../../PerforceService";
import { PerforceSCMProvider } from "../../ScmProvider";
import { PerforceContentProvider } from "../../ContentProvider";
import {
    StubPerforceService,
    StubFile,
    getLocalFile,
    returnStdErr
} from "./StubPerforceService";
import { Display } from "../../Display";
import { Utils } from "../../Utils";
import * as path from "path";
import { Resource } from "../../scm/Resource";
import { Status } from "../../scm/Status";
import p4Commands from "../helpers/p4Commands";

chai.use(sinonChai);
chai.use(p4Commands);
chai.use(chaiAsPromised);

interface TestItems {
    instance: PerforceSCMProvider;
    stubService: StubPerforceService;
    execute: sinon.SinonStub;
    showMessage: sinon.SinonSpy;
    showError: sinon.SinonSpy;
    showImportantError: sinon.SinonSpy;
    refresh: sinon.SinonSpy;
}

describe("Model & ScmProvider modules", () => {
    const workspaceUri = vscode.workspace.workspaceFolders[0].uri;

    const basicFiles = {
        edit: {
            localFile: getLocalFile(workspaceUri, "testFolder", "a.txt"),
            depotPath: "//depot/testArea/testFolder/a.txt",
            depotRevision: 1,
            operation: Status.EDIT
        },
        delete: {
            localFile: getLocalFile(workspaceUri, "testFolder", "deleted.txt"),
            depotPath: "//depot/testArea/testFolder/deleted.txt",
            depotRevision: 2,
            operation: Status.DELETE
        },
        add: {
            localFile: getLocalFile(workspaceUri, "testFolder", "new.txt"),
            depotPath: "//depot/testArea/testFolder/new.txt",
            depotRevision: 3,
            operation: Status.ADD
        },
        moveAdd: {
            localFile: getLocalFile(workspaceUri, "testFolder", "moved.txt"),
            depotPath: "//depot/testArea/testFolder/moved.txt",
            depotRevision: 1,
            operation: Status.MOVE_ADD,
            resolveFromDepotPath: "//depot/testArea/testFolderOld/movedFrom.txt"
        },
        moveDelete: {
            localFile: getLocalFile(workspaceUri, "testFolderOld", "movedFrom.txt"),
            depotPath: "//depot/testArea/testFolderOld/movedFrom.txt",
            depotRevision: 3,
            operation: Status.MOVE_DELETE
        },
        branch: {
            localFile: getLocalFile(workspaceUri, "testFolder", "branched.txt"),
            depotPath: "//depot/testArea/testFolder/branched.txt",
            depotRevision: 1,
            operation: Status.BRANCH,
            resolveFromDepotPath: "//depot/testAreaOld/testFolder/branchedFrom.txt"
        },
        integrate: {
            localFile: getLocalFile(workspaceUri, "testFolder", "integrated.txt"),
            depotPath: "//depot/testArea/testFolder/integrated.txt",
            depotRevision: 7,
            operation: Status.INTEGRATE,
            resolveFromDepotPath: "//depot/testAreaOld/testFolder/integrated.txt"
        },
        shelveNoWorkspace: {
            depotPath: "//depot/testArea/testFolder/none.txt",
            depotRevision: 1,
            operation: Status.ADD
        },
        shelveEdit: {
            localFile: getLocalFile(workspaceUri, "testFolder", "a.txt"),
            depotPath: "//depot/testArea/testFolder/a.txt",
            depotRevision: 1,
            operation: Status.EDIT
        },
        shelveDelete: {
            localFile: getLocalFile(workspaceUri, "testFolder", "deleted.txt"),
            depotPath: "//depot/testArea/testFolder/deleted.txt",
            depotRevision: 2,
            operation: Status.DELETE
        }
    };

    const config: IPerforceConfig = {
        localDir: workspaceUri.fsPath,
        p4Client: "cli",
        p4User: "user"
    };

    let items: TestItems;
    let subscriptions: vscode.Disposable[] = [];

    const doc = new PerforceContentProvider("perforce");

    before(async () => {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });
    after(() => {
        doc.dispose();
    });
    describe("Refresh / Initialize", function() {
        let stubService: StubPerforceService;
        let instance: PerforceSCMProvider;
        this.beforeEach(function() {
            this.timeout(4000);

            stubService = new StubPerforceService();
            stubService.changelists = [];
            stubService.stubExecute();

            instance = new PerforceSCMProvider(config, workspaceUri, "perforce");
            subscriptions.push(instance);
        });
        this.afterEach(() => {
            subscriptions.forEach(sub => sub.dispose());
            sinon.restore();
        });
        it("Handles no changelists", async () => {
            stubService.changelists = [];

            await instance.Initialize();
            expect(instance.resources).to.have.length(1);
            expect(instance.resources[0].resourceStates).to.be.resources([]);
            expect(instance.resources[0].id).to.equal("default");
            expect(instance.resources[0].label).to.equal("Default Changelist");
        });
        it("Handles changelists with no open files", async () => {
            stubService.changelists = [
                {
                    chnum: "1",
                    description: "changelist 1",
                    files: []
                }
            ];
            await instance.Initialize();
            expect(instance.resources).to.have.length(2);
            expect(instance.resources[0].id).to.equal("default");
            expect(instance.resources[0].label).to.equal("Default Changelist");
            expect(instance.resources[0].resourceStates).to.be.resources([]);
            expect(instance.resources[1].id).to.equal("pending:1");
            expect(instance.resources[1].label).to.equal("#1: changelist 1");
            expect(instance.resources[1].resourceStates).to.be.resources([]);
        });
        it("Handles open files with no shelved files", async () => {
            stubService.changelists = [
                {
                    chnum: "default",
                    description: "n/a",
                    files: [basicFiles.branch]
                },
                {
                    chnum: "1",
                    description: "changelist 1",
                    files: [basicFiles.edit, basicFiles.delete, basicFiles.add]
                },
                {
                    chnum: "2",
                    description: "changelist 2",
                    files: [basicFiles.moveAdd, basicFiles.moveDelete]
                }
            ];

            await instance.Initialize();

            expect(instance.resources).to.have.length(3);

            expect(instance.resources[0].id).to.equal("default");
            expect(instance.resources[0].resourceStates).to.be.resources([
                basicFiles.branch
            ]);
            expect(instance.resources[1].id).to.equal("pending:1");
            expect(instance.resources[1].label).to.equal("#1: changelist 1");
            expect(instance.resources[1].resourceStates).to.be.resources([
                basicFiles.edit,
                basicFiles.delete,
                basicFiles.add
            ]);
            expect(instance.resources[2].id).to.equal("pending:2");
            expect(instance.resources[2].label).to.equal("#2: changelist 2");
            expect(instance.resources[2].resourceStates).to.be.resources([
                basicFiles.moveAdd,
                basicFiles.moveDelete
            ]);
        });
        it("Handles shelved files with no open files", async () => {
            stubService.changelists = [
                {
                    chnum: "3",
                    description: "shelved changelist 1",
                    files: [],
                    shelvedFiles: [basicFiles.shelveEdit]
                },
                {
                    chnum: "4",
                    description: "shelved changelist 2",
                    files: [],
                    shelvedFiles: [basicFiles.shelveDelete]
                }
            ];

            await instance.Initialize();

            expect(instance.resources).to.have.length(3);

            expect(instance.resources[0].id).to.equal("default");
            expect(instance.resources[0].resourceStates).to.be.resources([]);

            expect(instance.resources[1].id).to.equal("pending:3");
            expect(instance.resources[1].label).to.equal("#3: shelved changelist 1");
            expect(instance.resources[1].resourceStates).to.be.shelvedResources([
                basicFiles.shelveEdit
            ]);

            expect(instance.resources[2].id).to.equal("pending:4");
            expect(instance.resources[2].label).to.equal("#4: shelved changelist 2");
            expect(instance.resources[2].resourceStates).to.be.shelvedResources([
                basicFiles.shelveDelete
            ]);
        });
        it("Handles open and shelved files", async () => {
            stubService.changelists = [
                {
                    chnum: "5",
                    description: "mixed changelist 1",
                    files: [basicFiles.edit, basicFiles.add],
                    shelvedFiles: [basicFiles.shelveEdit]
                },
                {
                    chnum: "6",
                    description: "mixed changelist 2",
                    files: [basicFiles.delete],
                    shelvedFiles: [basicFiles.shelveDelete]
                }
            ];

            await instance.Initialize();

            expect(instance.resources).to.have.length(3);

            expect(instance.resources[0].id).to.equal("default");
            expect(instance.resources[0].resourceStates).to.be.resources([]);

            expect(instance.resources[1].id).to.equal("pending:5");
            expect(instance.resources[1].label).to.equal("#5: mixed changelist 1");
            expect(
                instance.resources[1].resourceStates.slice(0, 1)
            ).to.be.shelvedResources([basicFiles.shelveEdit]);
            expect(instance.resources[1].resourceStates.slice(1)).to.be.resources([
                basicFiles.edit,
                basicFiles.add
            ]);

            expect(instance.resources[2].id).to.equal("pending:6");
            expect(instance.resources[2].label).to.equal("#6: mixed changelist 2");
            expect(
                instance.resources[2].resourceStates.slice(0, 1)
            ).to.be.shelvedResources([basicFiles.shelveDelete]);
            expect(instance.resources[2].resourceStates.slice(1)).to.be.resources([
                basicFiles.delete
            ]);
        });
        it("Includes new files open for shelve and not in the workspace", async () => {
            stubService.changelists = [
                {
                    chnum: "7",
                    description: "changelist 1",
                    files: [],
                    shelvedFiles: [basicFiles.shelveNoWorkspace]
                }
            ];

            await instance.Initialize();

            expect(instance.resources[0].id).to.equal("default");
            expect(instance.resources[0].resourceStates).to.be.resources([]);

            expect(instance.resources[1].id).to.equal("pending:7");
            expect(instance.resources[1].label).to.equal("#7: changelist 1");

            expect(instance.resources[1].resourceStates).to.be.shelvedResources([
                basicFiles.shelveNoWorkspace
            ]);
        });
        it("Handles the same file shelved in two changelists", async () => {
            stubService.changelists = [
                {
                    chnum: "8",
                    description: "changelist 1",
                    files: [],
                    shelvedFiles: [basicFiles.shelveEdit]
                },
                {
                    chnum: "9",
                    description: "changelist 2",
                    files: [],
                    shelvedFiles: [basicFiles.shelveEdit]
                }
            ];

            await instance.Initialize();

            expect(instance.resources).to.have.length(3);

            expect(instance.resources[0].id).to.equal("default");
            expect(instance.resources[0].resourceStates).to.be.resources([]);

            expect(instance.resources[1].id).to.equal("pending:8");
            expect(instance.resources[1].label).to.equal("#8: changelist 1");

            expect(instance.resources[1].resourceStates).to.be.shelvedResources([
                basicFiles.shelveEdit
            ]);

            expect(instance.resources[2].id).to.equal("pending:9");
            expect(instance.resources[2].label).to.equal("#9: changelist 2");

            expect(instance.resources[2].resourceStates).to.be.shelvedResources([
                basicFiles.shelveEdit
            ]);
        });
        // TODO configuration stubbing (or integration of config settings)
        it("Can sort changelists descending");
        it("Has decorations for files", async () => {
            stubService.changelists = [
                {
                    chnum: "1",
                    description: "changelist 1",
                    files: [basicFiles.edit, basicFiles.delete],
                    shelvedFiles: [basicFiles.shelveEdit, basicFiles.shelveDelete]
                }
            ];

            await instance.Initialize();

            expect(instance.resources[1].resourceStates[0].decorations).to.include({
                strikeThrough: false,
                faded: true
            });

            expect(instance.resources[1].resourceStates[1].decorations).to.include({
                strikeThrough: true,
                faded: true
            });

            expect(instance.resources[1].resourceStates[2].decorations).to.include({
                strikeThrough: false,
                faded: false
            });

            expect(instance.resources[1].resourceStates[3].decorations).to.include({
                strikeThrough: true,
                faded: false
            });
        });
        // TODO config
        it("Handles more than the max files per command");
        it("Can be refreshed");
        it("Can be refreshed multiple times without duplication");
    });
    describe("Actions", function() {
        beforeEach(async function() {
            this.timeout(4000);
            const showMessage = sinon.spy(Display, "showMessage");
            const showError = sinon.spy(Display, "showError");

            const stubService = new StubPerforceService();
            stubService.changelists = [
                {
                    chnum: "1",
                    description: "Changelist 1",
                    files: [
                        basicFiles.edit,
                        basicFiles.delete,
                        basicFiles.add,
                        basicFiles.moveAdd,
                        basicFiles.moveDelete,
                        basicFiles.branch,
                        basicFiles.integrate
                    ],
                    shelvedFiles: [basicFiles.shelveEdit, basicFiles.shelveDelete]
                },
                {
                    chnum: "2",
                    description: "Changelist 2",
                    files: [],
                    behaviours: {
                        shelve: returnStdErr("my shelve error"),
                        unshelve: returnStdErr("my unshelve error")
                    }
                },
                {
                    chnum: "3",
                    description: "Changelist 3",
                    submitted: true,
                    files: []
                }
            ];
            const execute = stubService.stubExecute();

            const instance = new PerforceSCMProvider(config, workspaceUri, "perforce");
            subscriptions.push(instance);
            await instance.Initialize();

            const showImportantError = sinon.spy(Display, "showImportantError");

            const refresh = sinon.spy();

            items = {
                stubService,
                instance,
                execute,
                showMessage,
                showError,
                showImportantError,
                refresh
            };

            subscriptions.push(instance.onRefreshStarted(refresh));
        });
        afterEach(async () => {
            await vscode.commands.executeCommand("workbench.action.closeAllEditors");
            subscriptions.forEach(sub => sub.dispose());
            subscriptions = [];
            sinon.restore();
        });

        describe("Shelving a changelist", () => {
            it("Cannot shelve the default changelist", async () => {
                await expect(
                    PerforceSCMProvider.ShelveChangelist(items.instance.resources[0])
                ).to.eventually.be.rejectedWith("Cannot shelve the default changelist");
                expect(items.execute).not.to.have.been.calledWithMatch(
                    workspaceUri,
                    "shelve"
                );
                expect(items.refresh).not.to.have.been.called;
            });

            it("Can shelve a valid Changelist", async () => {
                await PerforceSCMProvider.ShelveChangelist(items.instance.resources[1]);
                expect(items.execute).to.have.been.calledWithMatch(
                    workspaceUri,
                    "shelve",
                    sinon.match.any,
                    "-f -c 1"
                );
                expect(items.showMessage).to.have.been.calledOnceWith(
                    "Changelist shelved"
                );
                expect(items.refresh).to.have.been.calledOnce;
            });

            it("Can shelve and revert a valid changelist", async () => {
                await PerforceSCMProvider.ShelveRevertChangelist(
                    items.instance.resources[1]
                );
                expect(items.execute).to.have.been.calledWithMatch(
                    workspaceUri,
                    "shelve",
                    sinon.match.any,
                    "-f -c 1"
                );
                expect(items.execute).to.have.been.calledWithMatch(
                    workspaceUri,
                    "revert",
                    sinon.match.any,
                    "-c 1 //..."
                );
                expect(items.showMessage).to.have.been.calledOnceWith(
                    "Changelist shelved"
                );
                expect(items.refresh).to.have.been.calledOnce;
            });

            it("Can handle an error when shelving a changelist", async () => {
                await PerforceSCMProvider.ShelveChangelist(items.instance.resources[2]);
                expect(items.execute).to.have.been.calledWithMatch(
                    workspaceUri,
                    "shelve",
                    sinon.match.any,
                    "-f -c 2"
                );
                expect(items.showMessage).not.to.have.been.called;
                expect(items.showImportantError).to.have.been.calledOnceWith(
                    "my shelve error"
                );
                expect(items.refresh).to.have.been.calledOnce;
            });

            it("Can handle an error when shelving and reverting a changelist", async () => {
                await PerforceSCMProvider.ShelveRevertChangelist(
                    items.instance.resources[2]
                );
                expect(items.execute).to.have.been.calledWithMatch(
                    workspaceUri,
                    "shelve",
                    sinon.match.any,
                    "-f -c 2"
                );
                expect(items.showMessage).not.to.have.been.called;
                expect(items.showImportantError).to.have.been.calledOnceWith(
                    "my shelve error"
                );
                expect(items.execute).not.to.have.been.calledWithMatch(
                    workspaceUri,
                    "revert"
                );
                expect(items.refresh).to.have.been.calledOnce;
            });
        });

        describe("Unshelving a changelist", () => {
            it("Can unshelve a valid Changelist", async () => {
                await PerforceSCMProvider.UnshelveChangelist(items.instance.resources[1]);
                expect(items.execute).to.have.been.calledWithMatch(
                    workspaceUri,
                    "unshelve",
                    sinon.match.any,
                    "-f -s 1"
                );
                expect(items.showMessage).to.have.been.calledOnceWith(
                    "Changelist unshelved"
                );
                expect(items.refresh).to.have.been.calledOnce;
            });

            it("Cannot unshelve default changelist", async () => {
                await expect(
                    PerforceSCMProvider.UnshelveChangelist(items.instance.resources[0])
                ).to.eventually.be.rejectedWith("Cannot unshelve the default changelist");
                expect(items.execute).not.to.have.been.calledWithMatch(
                    workspaceUri,
                    "unshelve"
                );
                expect(items.refresh).not.to.have.been.called;
            });

            it("Can handle an error when unshelving a changelist", async () => {
                await PerforceSCMProvider.UnshelveChangelist(items.instance.resources[2]);
                expect(items.execute).to.have.been.calledWithMatch(
                    workspaceUri,
                    "unshelve",
                    sinon.match.any,
                    "-f -s 2 -c 2"
                );
                expect(items.showMessage).not.to.have.been.called;
                expect(items.showImportantError).to.have.been.calledOnceWith(
                    "my unshelve error"
                );
                expect(items.refresh).not.to.have.been.called;
            });
        });

        describe("Deleting a shelve", () => {
            it("Deletes a shelved changelist", async () => {
                // accept the warning
                const warn = sinon
                    .stub(vscode.window, "showWarningMessage")
                    .resolvesArg(2);

                await PerforceSCMProvider.DeleteShelvedChangelist(
                    items.instance.resources[1]
                );

                expect(warn).to.have.been.calledOnce;
                expect(items.refresh).to.have.been.calledOnce;
                expect(items.execute).to.have.been.calledWithMatch(
                    workspaceUri,
                    "shelve",
                    sinon.match.any,
                    "-d -c 1"
                );
            });

            it("Can cancel deleting a shelved changelist", async () => {
                // close the warning without accepting
                const warn = sinon
                    .stub(vscode.window, "showWarningMessage")
                    .resolves(undefined);

                await PerforceSCMProvider.DeleteShelvedChangelist(
                    items.instance.resources[1]
                );

                expect(warn).to.have.been.calledOnce;
                expect(items.refresh).not.to.have.been.called;
                expect(items.execute).not.to.have.been.calledWithMatch(
                    workspaceUri,
                    "shelve"
                );
            });

            it("Can handle an error when deleting a shelved changelist", async () => {
                // accept the warning
                const warn = sinon
                    .stub(vscode.window, "showWarningMessage")
                    .resolvesArg(2);

                await PerforceSCMProvider.DeleteShelvedChangelist(
                    items.instance.resources[2]
                );

                expect(warn).to.have.been.calledOnce;
                expect(items.execute).to.have.been.calledWithMatch(
                    workspaceUri,
                    "shelve",
                    sinon.match.any,
                    "-d -c 2"
                );
                expect(items.showImportantError).to.have.been.calledOnceWith(
                    "my shelve error"
                );
                expect(items.refresh).not.to.have.been.called;
            });

            it("Cannot delete from the default changelist", async () => {
                await expect(
                    PerforceSCMProvider.DeleteShelvedChangelist(
                        items.instance.resources[0]
                    )
                ).to.eventually.be.rejectedWith(
                    "Cannot delete shelved files from the default changelist"
                );
                expect(items.execute).not.to.have.been.calledWithMatch(
                    workspaceUri,
                    "shelve"
                );
                expect(items.refresh).not.to.have.been.called;
            });
        });

        describe("Opening", () => {
            function findResourceForShelvedFile(
                group: vscode.SourceControlResourceGroup,
                file: StubFile
            ) {
                return group.resourceStates.find(
                    resource =>
                        (resource as Resource).isShelved &&
                        Utils.getDepotPathFromDepotUri(resource.resourceUri) ===
                            file.depotPath
                );
            }

            function findResourceForFile(
                group: vscode.SourceControlResourceGroup,
                file: StubFile
            ) {
                return group.resourceStates.find(
                    resource =>
                        !(resource as Resource).isShelved &&
                        (resource as Resource).resourceUri.fsPath ===
                            file.localFile.fsPath
                );
            }

            /**
             * Matches against a perforce URI, containing a local file's path
             * @param file
             */
            function perforceLocalUriMatcher(file: StubFile) {
                return Utils.makePerforceDocUri(file.localFile, "print", "-q", {
                    workspace: workspaceUri.fsPath
                });
            }

            /**
             * Matches against a perforce URI, using the depot path for a file
             * @param file
             */
            function perforceDepotUriMatcher(file: StubFile) {
                return Utils.makePerforceDocUri(
                    vscode.Uri.parse("perforce:" + file.depotPath),
                    "print",
                    "-q",
                    { depot: true, workspace: workspaceUri.fsPath }
                );
            }

            /**
             * Matches against a perforce URI, using the resolvedFromFile0 depot path
             * @param file
             */
            function perforceFromFileUriMatcher(file: StubFile) {
                return Utils.makePerforceDocUri(
                    vscode.Uri.parse("perforce:" + file.resolveFromDepotPath),
                    "print",
                    "-q",
                    { depot: true, workspace: workspaceUri.fsPath }
                );
            }

            /**
             * Matches against a perforce URI, using the depot path for the file AND containing a fragment for the shelved changelist number
             * @param file
             * @param chnum
             */
            function perforceShelvedUriMatcher(file: StubFile, chnum: string) {
                return Utils.makePerforceDocUri(
                    vscode.Uri.parse("perforce:" + file.depotPath).with({
                        fragment: "@=" + chnum
                    }),
                    "print",
                    "-q",
                    { depot: true, workspace: workspaceUri.fsPath }
                );
            }

            function perforceLocalShelvedUriMatcher(file: StubFile, chnum: string) {
                return Utils.makePerforceDocUri(
                    file.localFile.with({ fragment: "@=" + chnum }),
                    "print",
                    "-q",
                    { workspace: workspaceUri.fsPath }
                );
            }

            let execCommand: sinon.SinonSpy;
            beforeEach(function() {
                this.timeout(4000);
                execCommand = sinon.spy(vscode.commands, "executeCommand");
            });

            describe("When opening a file", () => {
                it("Opens the underlying workspace file", () => {
                    const file = items.stubService.changelists[0].files[0];
                    const resource = findResourceForFile(
                        items.instance.resources[1],
                        file
                    );

                    PerforceSCMProvider.OpenFile(resource);

                    expect(execCommand.lastCall).to.be.vscodeOpenCall(file.localFile);
                });
                it("Can open multiple files", () => {
                    const file1 = items.stubService.changelists[0].files[0];
                    const resource1 = findResourceForFile(
                        items.instance.resources[1],
                        file1
                    );

                    const file2 = items.stubService.changelists[0].files[2];
                    const resource2 = findResourceForFile(
                        items.instance.resources[1],
                        file2
                    );

                    PerforceSCMProvider.OpenFile(resource1, resource2);
                    expect(execCommand.getCall(-2)).to.be.vscodeOpenCall(file1.localFile);
                    expect(execCommand.lastCall).to.be.vscodeOpenCall(file2.localFile);
                });
            });
            describe("When opening an scm resource", () => {
                it("Diffs a local file against the depot file", async () => {
                    const file = items.stubService.changelists[0].files[0];
                    const resource = findResourceForFile(
                        items.instance.resources[1],
                        file
                    );

                    await PerforceSCMProvider.Open(resource);

                    expect(execCommand.lastCall).to.be.vscodeDiffCall(
                        perforceLocalUriMatcher(file),
                        file.localFile,
                        path.basename(file.localFile.path) +
                            " - Diff Workspace (right) Against Most Recent Revision (left)"
                    );
                    expect(items.execute).to.be.calledWithMatch(
                        file.localFile,
                        "print",
                        sinon.match.any,
                        '-q "' + file.localFile.fsPath + '"'
                    );
                });
                it("Can open multiple resources", async () => {
                    const file1 = items.stubService.changelists[0].files[0];
                    const resource1 = findResourceForFile(
                        items.instance.resources[1],
                        file1
                    );

                    const file2 = items.stubService.changelists[0].files[1];
                    const resource2 = findResourceForFile(
                        items.instance.resources[1],
                        file2
                    );

                    await PerforceSCMProvider.Open(resource1, resource2);
                    expect(execCommand.getCall(-2)).to.be.vscodeDiffCall(
                        perforceLocalUriMatcher(file1),
                        file1.localFile,
                        path.basename(file1.localFile.path) +
                            " - Diff Workspace (right) Against Most Recent Revision (left)"
                    );
                    expect(items.execute).to.be.calledWithMatch(
                        file1.localFile,
                        "print",
                        sinon.match.any,
                        '-q "' + file1.localFile.fsPath + '"'
                    );
                    expect(execCommand.lastCall).to.be.vscodeOpenCall(
                        perforceLocalUriMatcher(file2)
                    );
                });
                it("Displays the depot version of a deleted file", () => {
                    const file = items.stubService.changelists[0].files[1];
                    const resource = findResourceForFile(
                        items.instance.resources[1],
                        file
                    );

                    PerforceSCMProvider.Open(resource);

                    expect(execCommand.lastCall).to.be.vscodeOpenCall(
                        perforceLocalUriMatcher(file)
                    );
                });
                it("Diffs a new file against an empty file", () => {
                    const file = items.stubService.changelists[0].files[2];
                    const resource = findResourceForFile(
                        items.instance.resources[1],
                        file
                    );

                    PerforceSCMProvider.Open(resource);

                    expect(execCommand.lastCall).to.be.vscodeDiffCall(
                        vscode.Uri.parse("perforce:EMPTY"),
                        file.localFile,
                        path.basename(file.localFile.path) +
                            " - Diff Workspace (right) Against Most Recent Revision (left)"
                    );
                });
                it("Diffs a moved file against the original file", async () => {
                    const file = items.stubService.changelists[0].files[3];
                    const resource = findResourceForFile(
                        items.instance.resources[1],
                        file
                    );

                    await PerforceSCMProvider.Open(resource);

                    expect(execCommand.lastCall).to.be.vscodeDiffCall(
                        perforceFromFileUriMatcher(file),
                        file.localFile,
                        path.basename(file.localFile.path) +
                            " - Diff Workspace (right) Against Most Recent Revision (left)"
                    );
                    expect(items.execute).to.be.calledWithMatch(
                        sinon.match({ fsPath: workspaceUri.fsPath }),
                        "print",
                        sinon.match.any,
                        '-q "' + file.resolveFromDepotPath + '"'
                    );
                });
                it("Displays the depot version for a move / delete", () => {
                    const file = items.stubService.changelists[0].files[4];
                    const resource = findResourceForFile(
                        items.instance.resources[1],
                        file
                    );

                    PerforceSCMProvider.Open(resource);
                });
                it("Diffs a file opened for branch against an empty file", () => {
                    const file = items.stubService.changelists[0].files[5];
                    const resource = findResourceForFile(
                        items.instance.resources[1],
                        file
                    );

                    PerforceSCMProvider.Open(resource);

                    expect(execCommand.lastCall).to.be.vscodeDiffCall(
                        vscode.Uri.parse("perforce:EMPTY"),
                        file.localFile,
                        path.basename(file.localFile.path) +
                            " - Diff Workspace (right) Against Most Recent Revision (left)"
                    );
                });
                it("Diffs an integration/merge against the target depot file", async () => {
                    const file = items.stubService.changelists[0].files[6];
                    const resource = findResourceForFile(
                        items.instance.resources[1],
                        file
                    );

                    await PerforceSCMProvider.Open(resource);

                    expect(execCommand.lastCall).to.be.vscodeDiffCall(
                        perforceLocalUriMatcher(file),
                        file.localFile,
                        path.basename(file.localFile.path) +
                            " - Diff Workspace (right) Against Most Recent Revision (left)"
                    );

                    expect(items.execute).to.be.calledWithMatch(
                        file.localFile,
                        "print",
                        sinon.match.any,
                        '-q "' + file.localFile.fsPath + '"'
                    );
                });
                it("Diffs a shelved file against the depot file", async () => {
                    const file = items.stubService.changelists[0].shelvedFiles[0];
                    const resource = findResourceForShelvedFile(
                        items.instance.resources[1],
                        file
                    );

                    await PerforceSCMProvider.Open(resource);

                    expect(execCommand.lastCall).to.be.vscodeDiffCall(
                        perforceDepotUriMatcher(file),
                        perforceShelvedUriMatcher(file, "1"),
                        path.basename(file.localFile.path) +
                            " - Diff Shelve (right) Against Depot Version (left)"
                    );
                    expect(items.execute).to.be.calledWithMatch(
                        { fsPath: workspaceUri.fsPath },
                        "print",
                        sinon.match.any,
                        '-q "' + file.depotPath + '@=1"'
                    );
                    expect(items.execute).to.be.calledWithMatch(
                        { fsPath: workspaceUri.fsPath },
                        "print",
                        sinon.match.any,
                        '-q "' + file.depotPath + '"'
                    );
                });
                it("Can diff a local file against the shelved file (from the shelved file)", async () => {
                    const file = items.stubService.changelists[0].shelvedFiles[0];
                    const resource = findResourceForShelvedFile(
                        items.instance.resources[1],
                        file
                    );

                    await PerforceSCMProvider.OpenvShelved(resource);

                    expect(execCommand.lastCall).to.be.vscodeDiffCall(
                        perforceShelvedUriMatcher(file, "1"),
                        file.localFile,
                        path.basename(file.localFile.path) +
                            " - Diff Workspace (right) Against Shelved Version (left)"
                    );
                    expect(items.execute).to.be.calledWithMatch(
                        { fsPath: workspaceUri.fsPath },
                        "print",
                        sinon.match.any,
                        '-q "' + file.depotPath + '@=1"'
                    );
                });
                it("Can diff a local file against the shelved file (from the local file)", async () => {
                    const file = items.stubService.changelists[0].files[0];
                    const resource = findResourceForFile(
                        items.instance.resources[1],
                        file
                    );

                    await PerforceSCMProvider.OpenvShelved(resource);

                    expect(execCommand.lastCall).to.be.vscodeDiffCall(
                        perforceLocalShelvedUriMatcher(file, "1"),
                        file.localFile,
                        path.basename(file.localFile.path) +
                            " - Diff Workspace (right) Against Shelved Version (left)"
                    );
                    expect(items.execute).to.be.calledWithMatch(
                        file.localFile,
                        "print",
                        sinon.match.any,
                        '-q "' + file.localFile.fsPath + '@=1"'
                    );
                });
                it("Displays the depot version for a shelved deletion", async () => {
                    const file = items.stubService.changelists[0].files[1];
                    const resource = findResourceForFile(
                        items.instance.resources[1],
                        file
                    );

                    await PerforceSCMProvider.Open(resource);

                    expect(execCommand.lastCall).to.be.vscodeOpenCall(
                        perforceLocalUriMatcher(file)
                    );
                });
            });
        });
    });
});
