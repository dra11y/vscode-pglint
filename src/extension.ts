import * as vscode from 'vscode'
import { Client } from 'pg'

let channel!: vscode.OutputChannel

interface Statement {
	sql: string
	start: number
	end: number
}

export function splitSqlWithPositions(sql: string): Statement[] {
	const statements: Statement[] = []
	let currentStart = 0
	let currentText = ''

	let pos = 0
	let quoteChar: string | null = null
	let isLineComment = false
	let isBlockComment = false
	let isStatement = false

	const pushStatement = (endPos: number) => {
		if (currentText.trim()) {
			statements.push({
				sql: currentText,
				start: currentStart,
				end: endPos
			})
		}
		currentStart = endPos + 1
		currentText = ''
	}

	while (pos < sql.length) {
		const char = sql[pos]
		const nextChar = sql[pos + 1]

		// Handle line comments
		if (isLineComment) {
			isStatement = false
			// currentText += char
			if (char === '\n') {
				isLineComment = false
			}
			pos++
			continue
		}

		// channel.appendLine(`-- CHAR: ${char}, pos: ${pos}`)

		// Handle block comments
		if (isBlockComment) {
			isStatement = false
			// currentText += char
			if (char === '*' && nextChar === '/') {
				isBlockComment = false
				// currentText += nextChar
				pos++
			}
			pos++
			continue
		}

		if (!isStatement && /[\s\r\n]/.test(char)) {
			pos++
			continue
		}

		if (!isStatement) {
			currentStart = pos
			isStatement = true
		}

		// Check for comment starts
		if (char === '-' && nextChar === '-') {
			isLineComment = true
			isStatement = false
			// currentText += char + nextChar
			pos += 2
			continue
		}

		if (char === '/' && nextChar === '*') {
			isBlockComment = true
			isStatement = false
			// currentText += char + nextChar
			pos += 2
			continue
		}

		// Handle quotes
		if (quoteChar) {
			currentText += char
			if (char === quoteChar) {
				quoteChar = null
			}
			pos++
			continue
		}

		// Check for dollar quote start
		if (char === '$') {
			const slice = sql.slice(pos)
			const match = slice.match(/^\$([A-Za-z\u0080-\uffff_][A-Za-z\u0080-\uffff0-9_]*)?\$/)
			if (match) {
				const dollarTag = match[0] || '$$'

				const endTagPos = slice.substring(dollarTag.length).indexOf(dollarTag)
				if (endTagPos > -1) {
					const quotedText = slice.substring(0, endTagPos + dollarTag.length * 2)
					currentText += quotedText
					pos += quotedText.length
					continue
				}
			}
		}

		// Check for quote starts
		if (['"', "'", '`'].includes(char)) {
			quoteChar = char
			currentText += char
			pos++
			continue
		}

		// Split on semicolons
		if (char === ';') {
			currentText += char
			pushStatement(pos)
			isStatement = false
			pos++
			continue
		}

		// Regular character?
		currentText += char
		pos++
	}

	// Add final statement
	if (currentText.trim()) {
		statements.push({
			sql: currentText,
			start: currentStart,
			end: pos - 1
		})
	}

	return statements
}

async function lintDocument(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
	const config = vscode.workspace.getConfiguration('pglint')

	channel.appendLine(`LANGUAGE ID: ${document.languageId}`)

	collection.delete(document.uri)
	const sqlText = document.getText()
	const diagnostics: vscode.Diagnostic[] = []

	const statements = splitSqlWithPositions(sqlText)

	const connectionConfig = {
		host: config.get('host', 'localhost'),
		port: config.get('port', 5432),
		user: config.get('user', 'postgres'),
		password: config.get('password', ''),
		database: 'postgres'
	}

	const tempDbName = `vscode_pg_lint_${Date.now()}`

	try {
		const client = new Client(connectionConfig)
		channel.appendLine('Connecting to database...')
		await client.connect()
		channel.appendLine(`Creating temporary database: ${tempDbName}`)
		await client.query(`CREATE DATABASE ${tempDbName}`)
	} catch (error: any) {
		channel.appendLine(`ERROR: Failed to create temporary database: ${JSON.stringify(error)}`)
		// TODO: display error
		return
	}

	let client: Client
	try {
		client = new Client({ ...connectionConfig, database: tempDbName })
		await client.connect()
		channel.appendLine(`Connected to temporary database: ${tempDbName}`)
	} catch (error: any) {
		channel.appendLine(`ERROR: Failed to connect to temporary database: ${JSON.stringify(error)}`)
		// TODO: display error
		return
	}

	let statement!: Statement

	try {

		for (var i = 0; i < statements.length; i++) {
			statement = statements[i]
			await client.query(statement.sql)
		}

	} catch (err: any) {
		const { ...error } = err
		// position is 1-based
		const { hint } = error
		let { message } = err
		if (hint) {
			message += ` Hint: ${hint}`
		}
		const position = error.position ? parseInt(error.position) - 1 : null
		channel.appendLine(`ERROR: ${message} - ${JSON.stringify(error)}`)

		const { sql, start, end } = statement
		const statementRange = new vscode.Range(document.positionAt(start), document.positionAt(end))
		let statementDiagnostic = new vscode.Diagnostic(statementRange, message, vscode.DiagnosticSeverity.Error)
		const quoted = message.match(/\"([^"]+)\"/)
		if (quoted) {
			if (position && position < sql.length - quoted[1].length) {

				const errorStart = start + position
				const errorEnd = errorStart + quoted[1].length
				// channel.appendLine(`position: ${position}, len: ${sql.length}, errorStart: ${errorStart} - errorEnd: ${errorEnd}`)

				const errorRange = new vscode.Range(
					document.positionAt(errorStart),
					document.positionAt(errorEnd)
				)
				const errorDiagnostic = new vscode.Diagnostic(
					errorRange,
					message,
					vscode.DiagnosticSeverity.Error
				)
				diagnostics.push(errorDiagnostic)
				statementDiagnostic.severity = vscode.DiagnosticSeverity.Warning
				statementDiagnostic.message = `In this statement: ${message}`

			} else {

				const pattern = quoted[1].match(/^[^a-zA-Z0-9]+$/)
					? new RegExp(quoted[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')  // Special chars
					: new RegExp(`\\b${quoted[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')  // Words

				const quotedMatches = Array.from(sql.matchAll(pattern))

				if (quotedMatches.length > 0) {
					// channel.appendLine(`matches found: ${quotedMatches.length}`)
					statementDiagnostic.severity = vscode.DiagnosticSeverity.Warning
					statementDiagnostic.message = `In this statement: ${message}`

					// Create diagnostic for each match
					for (const match of quotedMatches) {
						const errorStart = start + match.index
						const errorEnd = errorStart + quoted[1].length
						const errorRange = new vscode.Range(
							document.positionAt(errorStart),
							document.positionAt(errorEnd)
						)
						const errorDiagnostic = new vscode.Diagnostic(
							errorRange,
							message,
							vscode.DiagnosticSeverity.Error
						)
						diagnostics.push(errorDiagnostic)
					}
				}
			}
		} else if (position) {
			const word = sql.substring(position).match(/\b|$/)
			const length = word?.index ?? sql.length - position

			const errorStart = start + position
			const errorEnd = errorStart + length

			const errorRange = new vscode.Range(
				document.positionAt(errorStart),
				document.positionAt(errorEnd)
			)
			const errorDiagnostic = new vscode.Diagnostic(
				errorRange,
				message,
				vscode.DiagnosticSeverity.Error
			)
			diagnostics.push(errorDiagnostic)
			statementDiagnostic.severity = vscode.DiagnosticSeverity.Warning
			statementDiagnostic.message = `In this statement: ${message}`

		}
		diagnostics.push(statementDiagnostic)

		// if (end + 1 < sqlText.length) {
		const unreachableRange = new vscode.Range(document.positionAt(end + 1), document.positionAt(sqlText.length))
		const unreachableDiagnostic = new vscode.Diagnostic(unreachableRange, "Untested statements", vscode.DiagnosticSeverity.Hint)
		unreachableDiagnostic.tags = [vscode.DiagnosticTag.Unnecessary]
		diagnostics.push(unreachableDiagnostic)
		// channel.appendLine(`added unreachable range: ${JSON.stringify(unreachableRange)}`)
		// }
		// channel.appendLine(`ERROR running query:\n${JSON.stringify(error)}\nquery: ${statement.sql}\n${JSON.stringify(statement)}`)
		collection.set(document.uri, diagnostics)
	} finally {
		try {
			await client.end()
			const cleanupClient = new Client(connectionConfig)
			await cleanupClient.connect()
			channel.appendLine('Running cleanup...')
			await cleanupClient.query(`DROP DATABASE IF EXISTS ${tempDbName}`)
			await cleanupClient.end()
			channel.appendLine('Cleanup completed')
		} catch (error: any) {
			channel.appendLine(`Cleanup error: ${error.message}`)
		}
	}
}


export function activate(context: vscode.ExtensionContext) {
	channel = vscode.window.createOutputChannel("PG Lint")

	const diagnosticCollection = vscode.languages.createDiagnosticCollection('pglint')
	context.subscriptions.push(diagnosticCollection)

	// const commandSubscription = vscode.commands.registerCommand('pglint.runLint', async () => {
	// 	const editor = vscode.window.activeTextEditor
	// 	if (!editor) {
	// 		channel.appendLine('No active editor')
	// 		return
	// 	}
	// 	channel.appendLine(`Linting document with language ID: ${editor.document.languageId}`)
	// 	await lintDocument(editor.document, diagnosticCollection)
	// })
	// context.subscriptions.push(commandSubscription)

	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
		// Clear old diagnostics
		diagnosticCollection.delete(document.uri)
		lintDocument(document, diagnosticCollection)
	}))
}

export function deactivate() {
	channel.appendLine('-- Extension deactivating')
	if (channel) {
		channel.dispose()
	}
}
