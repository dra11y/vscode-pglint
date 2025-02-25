import * as vscode from 'vscode'
import { setup, teardown, getConfigManager, LINT_COMMAND, EXTENSION_NAME, getChannel, TERMINATE_COMMAND } from './config'
import { lintDocument, terminateTemplateConnections } from './lintDocument'
import { IncludeLinkProvider } from './linkProvider'
import { IncludeCompletionProvider } from './includeCompletionProvider'

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

	subscriptions.push(vscode.commands.registerCommand(TERMINATE_COMMAND, async () => {
		const { languageIds } = configManager.get()
		const document = vscode.window.activeTextEditor?.document
		if (document && languageIds.includes(document.languageId)) {
			await terminateTemplateConnections(document, diagnosticCollection)
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

	const linkProvider = new IncludeLinkProvider()
	const completionProvider = new IncludeCompletionProvider()
	let providerRegistrations: vscode.Disposable[] = []

	const registerProviders = () => {
		providerRegistrations.forEach(disposable => disposable.dispose())
		providerRegistrations = []
		const triggerChars = ' ./'.split('')
		const { languageIds } = configManager.get()
		providerRegistrations = languageIds.flatMap(id => [
			vscode.languages.registerDocumentLinkProvider({ scheme: 'file', language: id }, linkProvider),
			vscode.languages.registerCompletionItemProvider({ scheme: 'file', language: id }, completionProvider, ...triggerChars)
		])
		subscriptions.push(...providerRegistrations)
	}

	registerProviders()

	subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(EXTENSION_NAME)) {
			registerProviders()
		}
	}))
}

export function deactivate() {
	teardown()
}
