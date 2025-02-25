import * as vscode from 'vscode'
import { setup, teardown, getConfigManager, LINT_COMMAND, EXTENSION_NAME, getChannel } from './config'
import { lintDocument } from './lintDocument'
// import { oldLintDocument } from './oldLintDocument'

export function activate(context: vscode.ExtensionContext) {
	setup()

	const configManager = getConfigManager()

	const { subscriptions } = context
	subscriptions.push(configManager.getSubscription())

	const diagnosticCollection = vscode.languages.createDiagnosticCollection(EXTENSION_NAME)
	subscriptions.push(diagnosticCollection)

	subscriptions.push(vscode.commands.registerCommand(LINT_COMMAND, async () => {
		const { languageIds } = configManager.get()
		const document = vscode.window.activeTextEditor?.document
		if (document && languageIds.includes(document.languageId)) {
			await lintDocument(document, diagnosticCollection)
		}
	}))

	subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
		const { languageIds, lintOnSave } = configManager.get()
		if (!lintOnSave) {
			return
		}
		if (languageIds.includes(document.languageId)) {
			await lintDocument(document, diagnosticCollection)
			getChannel().appendLine(`FINISHED LINTING ${diagnosticCollection.get(document.uri)?.length}`)
		}
	}))

	subscriptions.push(vscode.workspace.onDidChangeTextDocument(async ({ document }) => {
		const { clearOnChange } = configManager.get()
		if (clearOnChange) {
			diagnosticCollection.set(document.uri, [])
		}
	}))
}

export function deactivate() {
	teardown()
}
