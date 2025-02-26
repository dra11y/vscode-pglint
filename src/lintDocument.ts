import { Client, ClientConfig } from 'pg'
import * as vscode from 'vscode'
import { EXTENSION_NAME, getChannel, getConfigManager } from './config'
import { checkFunction, CREATE_EXTENSION_PLPGSQL_CHECK, CREATE_FUNCTION_REGEX } from './plpgsqlCheckFunction'
import { showMessage } from './showMessage'
import { clearPositionsCaches, getLastPositionInFile, getLocationFromLength, getPosition, Location, quotedEqual, splitIntoStatements, TEMPLATE_DIRECTIVE_ERROR_FIRST } from './splitIntoStatements'
import { terminateBackend } from './terminateBackend'
import { validateDatabaseName } from './validateDatabaseName'
import { cleanupDatabase } from './cleanupDatabase'

function pushDiagnostics(collection: vscode.DiagnosticCollection, uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) {
    const existing = collection.get(uri) ?? []
    collection.set(uri, [...existing, ...diagnostics])
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

export async function lintDocument(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
    const config = getConfigManager().get()
    if (!config.languageIds.includes(document.languageId)) {
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

    // channel.appendLine(`STATEMENTS: \n${ JSON.stringify(statements, null, 4) } `)

    const template = statements[0].template
    if (template) {
        try {
            validateDatabaseName(template)
        } catch (e: any) {
            showMessage(vscode.LogLevel.Error, `invalid template name: ${template} `, e)
            return
        }
    }

    const postgresConfig: ClientConfig = { connectionString: config.databaseUrl }
    let tempDbConfig: ClientConfig

    const databasePrefix = config.tempDatabasePrefix.replace(/(^|[^"])"([^"]|$)/g, '$1""$2')

    const database = `${databasePrefix}${Date.now()} `
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
        // channel.appendLine(`postgresConfig: ${ JSON.stringify(setupClient) } `)
        channel.appendLine(`Creating temporary database: ${quotedDatabase} `)
        let create = `CREATE DATABASE ${quotedDatabase} `
        if (template) {
            if (config.autoTerminateTemplateConnections) {
                await terminateBackend(setupClient, template)
            }
            create += ` TEMPLATE ${template} `
        }
        await setupClient.query(create)
        tempDbConfig = {
            host: setupClient.host,
            port: setupClient.port,
            user: setupClient.user,
            password: setupClient.password,
            database
        }
        // channel.appendLine(`tempDbConfig: ${ JSON.stringify(tempDbConfig) } `)
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

        showMessage(vscode.LogLevel.Error, `Failed to create temporary database: ${database}, url: ${config.databaseUrl} `, error)
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
            throw new Error(`SELECT current_database() = ${currentDatabase} does NOT match expected temporary database name: ${quotedDatabase} `)
        }
        channel.appendLine(`Connected to database: ${client.database} `)
    } catch (error: any) {
        await client.end()
        showMessage(vscode.LogLevel.Error, `Failed to connect to temporary database: ${database}, url: ${config.databaseUrl} `, error)
        await cleanupDatabase(postgresConfig, database)
        return
    }

    let usePlPgsqlCheck = false
    if (config.usePlPgsqlCheck) {
        try {
            await client.query(CREATE_EXTENSION_PLPGSQL_CHECK)
            usePlPgsqlCheck = true
            channel.appendLine(`Using plpgsql_check.`)
        } catch (error: any) {
            channel.appendLine(`plpgsql_check not found.`)
        }
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
            } catch (err: any) {
                if (templateDiagnostic) {
                    templateDiagnostic.severity = vscode.DiagnosticSeverity.Warning
                }

                const { hint, message }: { hint: string, message: string } = err
                const messageWithHint = hint ? `${message} Hint: ${hint}` : message

                const { ...error } = { ...err, message }

                // const json = JSON.stringify(error, null, 4)
                // message += json

                let innerOffset = error.position ? parseInt(error.position) - 1 : null

                let includedDiagnostic: vscode.Diagnostic | null = null
                const { includedAt } = statement
                if (includedAt) {
                    includedDiagnostic = new vscode.Diagnostic(includedAt.range, `In included file: ${message} `, vscode.DiagnosticSeverity.Error)
                    includedDiagnostic.source = EXTENSION_NAME

                    const related = new vscode.DiagnosticRelatedInformation(
                        new vscode.Location(statementUri, range),
                        message,
                    )
                    includedDiagnostic.relatedInformation = [related]
                }

                let statementDiagnostic = new vscode.Diagnostic(range, `In this statement: ${message}}`, vscode.DiagnosticSeverity.Warning)
                statementDiagnostic.source = EXTENSION_NAME

                const sourceUnreachable = buildUnreachable(statement.location, statementDiagnostic)
                pushDiagnostics(collection, statementUri, [sourceUnreachable])

                // channel.appendLine(`ERROR: ${JSON.stringify(error)} `)

                // TODO: improve when postgres returns a quoted quote (""something"")

                const quotedMatch = message.match(/column "?(?:.+)"?|(?:.*)"([^"]+)"(?!.*")/)
                const quoted = quotedMatch?.[1] ?? quotedMatch?.[2] ?? null
                // channel.appendLine(`quoted: ${quoted}`)

                if (quoted || (innerOffset !== null && !isNaN(innerOffset))) {
                    const rest = sql.substring(innerOffset ?? 0)
                    let length = 1
                    if (quoted) {
                        const quotedOffset = Math.max(
                            rest.indexOf(quoted),
                            rest.toLowerCase().indexOf(quoted)
                        )
                        channel.appendLine(`innerOffset: ${innerOffset}, quoted: ${quoted}, quotedOffset: ${quotedOffset}, rest: ${rest}`)

                        if (quotedOffset > -1) {
                            if (innerOffset) {
                                innerOffset += quotedOffset
                            } else {
                                innerOffset = quotedOffset
                            }
                        }
                        length = quoted.length
                    } else {
                        const innerEnd = rest.match(/[^a-z0-9_"]|$/i)!
                        channel.appendLine(`innerEnd: ${innerEnd}`)
                        length = innerEnd.index!
                    }
                    length = Math.max(1, length)

                    const innerLocation = getLocationFromLength(statementUri, startOffset + (innerOffset ?? 0), length)
                    let innerDiagnostic = new vscode.Diagnostic(innerLocation.range, messageWithHint, vscode.DiagnosticSeverity.Error)
                    innerDiagnostic.source = EXTENSION_NAME

                    pushDiagnostics(collection, statementUri, [statementDiagnostic, innerDiagnostic])

                    if (includedAt && includedDiagnostic) {
                        const related = new vscode.DiagnosticRelatedInformation(
                            new vscode.Location(statementUri, innerLocation.range),
                            message,
                        )
                        includedDiagnostic.relatedInformation = [related]

                        channel.appendLine(`includeDiagnostic: ${JSON.stringify(includedDiagnostic)} `)

                        const includeUnreachable = buildUnreachable(includedAt, includedDiagnostic)

                        pushDiagnostics(collection, includedAt.uri, [includedDiagnostic, includeUnreachable])
                    }

                    return
                }

                statementDiagnostic.severity = vscode.DiagnosticSeverity.Error
                statementDiagnostic.message = messageWithHint
                pushDiagnostics(collection, statementUri, [statementDiagnostic])

                if (statement.includedAt && includedDiagnostic) {
                    pushDiagnostics(collection, statement.includedAt.uri, [includedDiagnostic])
                }

                channel.appendLine(`${i}: ERROR @${JSON.stringify(statement.location)}: ${JSON.stringify(err)} `)
                return
            }
        }
    } finally {
        await client.end()
        await cleanupDatabase(postgresConfig, database)
    }
}
