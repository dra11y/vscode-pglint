import { Client, ClientConfig } from 'pg'
import * as vscode from 'vscode'
import { EXTENSION_NAME, getChannel, getConfigManager, PgLintConfig } from './config'
import { checkFunction, CREATE_EXTENSION_PLPGSQL_CHECK, CREATE_FUNCTION_REGEX } from './plpgsqlCheckFunction'
import { showMessage } from './showMessage'
import { clearPositionsCaches, getLastPositionInFile, getLocationFromLength, getPosition, Location, quotedEqual, splitIntoStatements, TEMPLATE_DIRECTIVE_ERROR_FIRST } from './splitIntoStatements'
import { cleanupDatabase } from './cleanupDatabase'
import { createTempDatabase } from './createTempDatabase'
import { GeneralError, handleError, handleErrorShouldContinue, pushDiagnostics, StatementError } from './errors'

export async function lintDocument(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
    const config = getConfigManager().get()
    if (!config.languageIds.includes(document.languageId)) {
        return
    }

    const channel = getChannel()
    channel.clear()

    clearPositionsCaches()
    collection.set(document.uri, [])

    const statements = await splitIntoStatements(document.uri, document.getText())
    if (statements.length === 0) {
        return
    }

    const uris: Set<vscode.Uri> = new Set(statements.map(s => s.location.uri))
    for (const uri of uris) {
        collection.set(uri, [])
    }

    let tempDbConfig: ClientConfig
    try {
        tempDbConfig = await createTempDatabase(statements[0])
    } catch (e: any) {
        handleError(e, collection)
        return
    }

    const database = tempDbConfig.database!
    const { template } = statements[0]

    let templateDiagnostic: vscode.Diagnostic | null = null

    if (template) {
        const { location: { uri, range }, includedAt } = statements[0]
        const message = `using template: ${template}`
        templateDiagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Information)
        templateDiagnostic.source = EXTENSION_NAME
        pushDiagnostics(collection, uri, [templateDiagnostic])

        if (includedAt) {
            const includedDiagnostic = new vscode.Diagnostic(includedAt.range, message, vscode.DiagnosticSeverity.Information)
            includedDiagnostic.source = EXTENSION_NAME
            const related = new vscode.DiagnosticRelatedInformation(
                new vscode.Location(uri, range),
                message,
            )
            includedDiagnostic.relatedInformation = [related]
            pushDiagnostics(collection, includedAt.uri, [includedDiagnostic])
        }
    }

    let client = new Client(tempDbConfig)
    try {
        await client.connect()
        const result = await client.query('SELECT current_database();')
        const currentDatabase = result.rows[0].current_database
        if (database !== currentDatabase) {
            throw new Error(`current_database: ${currentDatabase} does NOT match expected temporary database name: ${database} `)
        }
        channel.appendLine(`Connected to database: ${client.database} `)
    } catch (error: any) {
        await client.end()
        showMessage(vscode.LogLevel.Error, `Failed to connect to temporary database: ${database}, url: ${config.databaseUrl} `, error)
        await cleanupDatabase(database)
        return
    }

    let usePlPgsqlCheck = false
    if (config.usePlPgsqlCheck) {
        try {
            await client.query(CREATE_EXTENSION_PLPGSQL_CHECK)
            usePlPgsqlCheck = true
            channel.appendLine(`Using plpgsql_check.`)
        } catch (error: any) {
            showMessage(vscode.LogLevel.Warning, `plpgsql_check extension not found. Install the extension to use this feature.`, error)
        }
    }

    const length = statements.length
    channel.appendLine(`statements: ${length}`)

    try {
        for (var i = 0; i < length; i++) {
            const statement = statements[i]
            if (statement.template) {
                if (i === 0 || (template && quotedEqual(template, statement.template))) {
                    continue
                }
                statement.error = TEMPLATE_DIRECTIVE_ERROR_FIRST
            }

            const { location: { uri: statementUri, range, startOffset }, sql } = statement

            if (statement.error) {
                const { includedAt } = statement
                if (includedAt) {
                    let includedDiagnostic = new vscode.Diagnostic(includedAt.range, `In included file: ${statement.error} `, vscode.DiagnosticSeverity.Error)
                    includedDiagnostic.source = EXTENSION_NAME
                    const related = new vscode.DiagnosticRelatedInformation(
                        new vscode.Location(statementUri, range),
                        statement.error,
                    )
                    includedDiagnostic.relatedInformation = [related]

                    pushDiagnostics(collection, includedAt.uri, [includedDiagnostic])
                }


                if (templateDiagnostic) {
                    templateDiagnostic.severity = vscode.DiagnosticSeverity.Warning
                }
                channel.appendLine(`STATEMENT ERROR ${i}: ${JSON.stringify(statement.location.range)} `)
                let diagnostic = new vscode.Diagnostic(statement.location.range, statement.error, vscode.DiagnosticSeverity.Error)
                diagnostic.source = EXTENSION_NAME
                pushDiagnostics(collection, statement.location.uri, [diagnostic])
                return
            }

            if (!sql) {
                channel.appendLine(`${i}: statement missing sql and error: ${JSON.stringify(statement)} `)
                continue
            }

            try {
                const start = config.queryStats ? performance.now() : null
                const { command, rowCount } = await client.query(sql)
                if (usePlPgsqlCheck && CREATE_FUNCTION_REGEX.test(sql)) {
                    await checkFunction(statement, client)
                }
                if (!config.queryStats) {
                    continue
                }
                const time = (performance.now() - start!).toFixed(3)
                let message = command
                if (rowCount !== null) {
                    message += rowCount === 1 ? ' 1 row' : ` ${rowCount} rows`
                }
                message += ` ${time} ms`
                let infoDiagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Hint)
                infoDiagnostic.source = EXTENSION_NAME
                pushDiagnostics(collection, statementUri, [infoDiagnostic])
            } catch (error: any) {
                if (templateDiagnostic) {
                    templateDiagnostic.severity = vscode.DiagnosticSeverity.Warning
                }

                const statementError = new StatementError({
                    statement,
                    error,
                    message: error.message,
                })

                if (!statementError.handleShouldContinue(collection)) {
                    return
                }
            }
        }
    } finally {
        await client.end()
        await cleanupDatabase(database)
    }
}
