import * as vscode from 'vscode'
import { EXTENSION_NAME, getChannel, getConfigManager } from './config'
import { clearPositionsCaches, getLastPositionInFile, getLocationFromLength, getPosition, Location, quotedEqual, splitIntoStatements, Statement, TEMPLATE_DIRECTIVE_ERROR_FIRST } from './splitIntoStatements'
import { Client, ClientConfig } from 'pg'
import { showMessage } from './showMessage'
import * as path from 'path'
import { validateDatabaseName } from './validateDatabaseName'

function pushDiagnostics(collection: vscode.DiagnosticCollection, uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) {
    const existing = collection.get(uri) ?? []
    collection.set(uri, [...existing, ...diagnostics])
}

async function terminateBackend(client: Client, database: string) {
    const channel = getChannel()
    const sql = `--sql
        SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = '${database}' AND pid <> pg_backend_pid();
    `
    try {
        channel.appendLine(`Terminating any active connections to ${database} ...`)
        await client.query(sql)
        channel.appendLine('Terminate completed')
    } catch (error: any) {
        showMessage(vscode.LogLevel.Error, `Failed to terminate backend pid(s) for: ${database}`, error)
    }
}

async function cleanupDatabase(config: ClientConfig, database: string) {
    const channel = getChannel()
    const cleanupClient = new Client(config)
    try {
        await cleanupClient.connect()
        channel.appendLine('Running cleanup...')
        await cleanupClient.query(`DROP DATABASE IF EXISTS "${database}";`)
        channel.appendLine('Cleanup completed')
    } catch (error: any) {
        showMessage(vscode.LogLevel.Error, `Failed to clean up temporary database: ${database}, url: ${config.connectionString}`, error)
    } finally {
        await cleanupClient.end()
    }
}

function buildUnreachable(location: Location, reason: vscode.Diagnostic): vscode.Diagnostic {
    const { uri, startOffset, length } = location
    const unreachableOffset = startOffset + length
    const unreachableStart = getPosition(uri, unreachableOffset)
    const unreachableEnd = getLastPositionInFile(uri)
    const unreachableRange = new vscode.Range(unreachableStart, unreachableEnd)
    let unreachable = new vscode.Diagnostic(
        unreachableRange,
        'unreachable statements',
        vscode.DiagnosticSeverity.Hint,
    )
    const related = new vscode.DiagnosticRelatedInformation(
        new vscode.Location(uri, unreachableRange),
        reason.message,
    )
    unreachable.relatedInformation = [related]
    unreachable.source = EXTENSION_NAME
    unreachable.tags = [vscode.DiagnosticTag.Unnecessary]
    return unreachable
}

export async function terminateTemplateConnections(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
    const { languageIds, databaseUrl: connectionString } = getConfigManager().get()
    const channel = getChannel()
    if (!languageIds.includes(document.languageId)) {
        return
    }
    const sqlText = document.getText()
    const statements = await splitIntoStatements(document.uri, sqlText)
    if (statements.length === 0) {
        return
    }
    const { template } = statements[0]
    if (!template) {
        return
    }
    try {
        validateDatabaseName(template)
    } catch (e: any) {
        showMessage(vscode.LogLevel.Error, `invalid template name: ${template}`, e)
        return
    }
    const postgresConfig: ClientConfig = { connectionString }
    const client = new Client(postgresConfig)

    try {
        channel.appendLine('Connecting to database...')
        await client.connect()
        await terminateBackend(client, template)
    } catch (error: any) {
        showMessage(vscode.LogLevel.Error, `Failed to terminate template backend connections for: ${template}, url: ${connectionString}`, error)
        return
    } finally {
        await client.end()
    }
}

export async function lintDocument(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
    const {
        languageIds,
        databaseUrl: connectionString,
        autoTerminateTemplateConnections,
        tempDatabasePrefix,
        queryStats,
    } = getConfigManager().get()
    if (!languageIds.includes(document.languageId)) {
        return
    }

    const channel = getChannel()
    channel.clear()

    clearPositionsCaches()
    collection.set(document.uri, [])

    const sqlText = document.getText()
    const statements = await splitIntoStatements(document.uri, sqlText)
    if (statements.length === 0) {
        return
    }

    const uris: Set<vscode.Uri> = new Set(statements.map(s => s.location.uri))
    for (const uri of uris) {
        collection.set(uri, [])
    }

    // channel.appendLine(`STATEMENTS:\n${JSON.stringify(statements, null, 4)}`)

    const template = statements[0].template
    if (template) {
        try {
            validateDatabaseName(template)
        } catch (e: any) {
            showMessage(vscode.LogLevel.Error, `invalid template name: ${template}`, e)
            return
        }
    }

    const postgresConfig: ClientConfig = { connectionString }
    let tempDbConfig: ClientConfig

    const databasePrefix = tempDatabasePrefix.replace(/(^|[^"])"([^"]|$)/g, '$1""$2')

    const database = `${databasePrefix}${Date.now()}`
    const quotedDatabase = `"${database}"`
    try {
        validateDatabaseName(quotedDatabase)
    } catch (e: any) {
        showMessage(vscode.LogLevel.Error, `Please set pglint.tempDatabasePrefix to a reasonable PostgreSQL database prefix.`, e)
        return
    }

    const setupClient = new Client(postgresConfig)

    try {
        channel.appendLine('Connecting to database...')
        await setupClient.connect()
        // channel.appendLine(`postgresConfig: ${JSON.stringify(setupClient)}`)
        channel.appendLine(`Creating temporary database: ${quotedDatabase}`)
        let create = `CREATE DATABASE ${quotedDatabase}`
        if (template) {
            if (autoTerminateTemplateConnections) {
                await terminateBackend(setupClient, template)
            }
            create += ` TEMPLATE ${template}`
        }
        await setupClient.query(create)
        tempDbConfig = {
            host: setupClient.host,
            port: setupClient.port,
            user: setupClient.user,
            password: setupClient.password,
            database
        }
        // channel.appendLine(`tempDbConfig: ${JSON.stringify(tempDbConfig)}`)
    } catch (error: any) {
        if (template) {
            let { message } = error
            if (message.includes('is being accessed by other users')) {
                message += ' (You can set pglint.autoTerminateTemplateConnections = true in settings to auto-terminate. WARNING! This will kill any active connections and queries on the template database.)'
            }
            const { location: { uri, range } } = statements[0]
            let diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error)
            diagnostic.source = EXTENSION_NAME
            pushDiagnostics(collection, uri, [diagnostic])
            return
        }

        showMessage(vscode.LogLevel.Error, `Failed to create temporary database: ${database}, url: ${connectionString}`, error)
        return
    } finally {
        await setupClient.end()
    }

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
            throw new Error(`SELECT current_database() = ${currentDatabase} does NOT match expected temporary database name: ${quotedDatabase}`)
        }
        channel.appendLine(`Connected to database: ${client.database}`)
    } catch (error: any) {
        await client.end()
        showMessage(vscode.LogLevel.Error, `Failed to connect to temporary database: ${database}, url: ${connectionString}`, error)
        await cleanupDatabase(postgresConfig, database)
        return
    }


    const length = statements.length
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
                    let includedDiagnostic = new vscode.Diagnostic(includedAt.range, `In included file: ${statement.error}`, vscode.DiagnosticSeverity.Error)
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
                channel.appendLine(`STATEMENT ERROR ${i}: ${JSON.stringify(statement.location.range)}`)
                let diagnostic = new vscode.Diagnostic(statement.location.range, statement.error, vscode.DiagnosticSeverity.Error)
                diagnostic.source = EXTENSION_NAME
                pushDiagnostics(collection, statement.location.uri, [diagnostic])
                return
            }

            if (!sql) {
                channel.appendLine(`${i}: statement missing sql and error: ${JSON.stringify(statement)}`)
                continue
            }

            try {
                const start = queryStats ? performance.now() : null
                const { command, rowCount } = await client.query(sql)
                if (!queryStats) {
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
            } catch (err: any) {
                if (templateDiagnostic) {
                    templateDiagnostic.severity = vscode.DiagnosticSeverity.Warning
                }

                let { hint, message }: { hint: string, message: string } = err
                if (hint) {
                    message += ` Hint: ${hint}`
                }
                const { ...error } = { ...err, message }
                const innerOffset = error.position ? parseInt(error.position) - 1 : null

                let includedDiagnostic: vscode.Diagnostic | null = null
                const { includedAt } = statement
                if (includedAt) {
                    includedDiagnostic = new vscode.Diagnostic(includedAt.range, `In included file: ${message}`, vscode.DiagnosticSeverity.Error)
                    includedDiagnostic.source = EXTENSION_NAME

                    const related = new vscode.DiagnosticRelatedInformation(
                        new vscode.Location(statementUri, range),
                        message,
                    )
                    includedDiagnostic.relatedInformation = [related]
                }

                let statementDiagnostic = new vscode.Diagnostic(range, `In this statement: ${message}`, vscode.DiagnosticSeverity.Warning)
                statementDiagnostic.source = EXTENSION_NAME

                const sourceUnreachable = buildUnreachable(statement.location, statementDiagnostic)
                pushDiagnostics(collection, statementUri, [sourceUnreachable])

                channel.appendLine(`ERROR: ${JSON.stringify(error)}`)

                // TODO: improve when postgres returns a quoted quote (""something"")
                const quotedMatch = message.match(/column ([^\s]+)|\"([^"]+)\"/)
                const quoted = quotedMatch?.[1] ?? quotedMatch?.[2] ?? null

                if (innerOffset !== null && !isNaN(innerOffset)) {
                    const rest = sql.substring(innerOffset)
                    let length: number
                    if (quoted) {
                        length = rest.indexOf(quoted) + quoted.length
                        channel.appendLine(`INNER OFFSET: ${innerOffset}, quoted: ${quoted}, length: ${length}`)
                    } else {
                        const innerEnd = rest.match(/\b|\s|\r|\n$/)
                        length = innerEnd?.index ?? sql.length - innerOffset
                    }

                    const innerLocation = getLocationFromLength(statementUri, startOffset + innerOffset, length)
                    let innerDiagnostic = new vscode.Diagnostic(innerLocation.range, message, vscode.DiagnosticSeverity.Error)
                    innerDiagnostic.source = EXTENSION_NAME

                    pushDiagnostics(collection, statementUri, [statementDiagnostic, innerDiagnostic])

                    if (includedAt && includedDiagnostic) {
                        const related = new vscode.DiagnosticRelatedInformation(
                            new vscode.Location(statementUri, innerLocation.range),
                            message,
                        )
                        includedDiagnostic.relatedInformation = [related]

                        channel.appendLine(`includeDiagnostic: ${JSON.stringify(includedDiagnostic)}`)

                        const includeUnreachable = buildUnreachable(includedAt, includedDiagnostic)

                        pushDiagnostics(collection, includedAt.uri, [includedDiagnostic, includeUnreachable])
                    }

                    return
                }

                statementDiagnostic.severity = vscode.DiagnosticSeverity.Error
                statementDiagnostic.message = message
                pushDiagnostics(collection, statementUri, [statementDiagnostic])

                if (statement.includedAt && includedDiagnostic) {
                    pushDiagnostics(collection, statement.includedAt.uri, [includedDiagnostic])
                }

                channel.appendLine(`${i}: ERROR @ ${JSON.stringify(statement.location)}: ${JSON.stringify(err)}`)
                return
            }
        }
    } finally {
        await client.end()
        await cleanupDatabase(postgresConfig, database)
    }
}
