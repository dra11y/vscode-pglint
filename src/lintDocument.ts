
import * as vscode from 'vscode'
import { splitSqlWithPositions, Statement } from './splitSqlWithPositions'
import { Client, ClientConfig } from 'pg'
import { getChannel, getConfigManager } from './config'
import { showMessage } from './showMessage'
import assert from 'assert'


function buildDiagnostic({
    document, message, offset, length }: {
        document: vscode.TextDocument,
        message: string,
        offset: number,
        length: number
    }): vscode.Diagnostic {
    const errorRange = new vscode.Range(
        document.positionAt(offset),
        document.positionAt(offset + length)
    )
    return new vscode.Diagnostic(
        errorRange,
        message,
        vscode.DiagnosticSeverity.Error
    )
}

async function processError({
    document, collection, statement, err }: {
        document: vscode.TextDocument,
        collection: vscode.DiagnosticCollection,
        statement: Statement,
        err: any
    }) {
    const channel = getChannel()
    const diagnostics: vscode.Diagnostic[] = []

    const finish = () => {
        if (diagnostics.length > 0) {
            statementDiagnostic.severity = vscode.DiagnosticSeverity.Warning
            statementDiagnostic.message = `In this statement: ${message}`
        }

        diagnostics.push(statementDiagnostic)

        diagnostics.push(buildUnreachableDiagnostic({ end, document }))
        collection.set(document.uri, diagnostics)
    }

    const { ...error } = err
    const { hint } = error
    let { message } = err
    if (hint) {
        message += ` Hint: ${hint}`
    }
    const relativeOffset = error.position ? parseInt(error.position) - 1 : null
    channel.appendLine(`ERROR: ${message} - ${JSON.stringify(error)}`)

    const { sql, start, end } = statement
    assert(sql!)
    const statementRange = new vscode.Range(document.positionAt(start), document.positionAt(end))
    let statementDiagnostic = new vscode.Diagnostic(statementRange, message, vscode.DiagnosticSeverity.Error)

    const quoted = message.match(/\"([^"]+)\"/)

    if (!quoted && relativeOffset && relativeOffset < sql.length - 1) {
        // channel.appendLine(`error - no quoted, relativeOffset = ${relativeOffset}`)
        const word = sql.substring(relativeOffset).match(/\b|$/)
        const length = word?.index ?? sql.length - relativeOffset
        diagnostics.push(buildDiagnostic({ document, message, offset: start + relativeOffset, length }))
        finish()
        return
    }

    if (!quoted) {
        // channel.appendLine(`error - no quoted, returning`)
        finish()
        return
    }

    const length = quoted[1].length
    if (relativeOffset && relativeOffset < sql.length - quoted[1].length) {
        // channel.appendLine(`error - quoted: ${quoted[1]}, relativeOffset: ${relativeOffset}`)

        diagnostics.push(buildDiagnostic({ document, message, offset: start + relativeOffset, length }))
    } else {
        // channel.appendLine(`error - quoted: ${quoted[1]}, no offset`)

        const pattern = quoted[1].match(/^[^a-zA-Z0-9]+$/)
            ? new RegExp(quoted[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')  // Special chars
            : new RegExp(`\\b${quoted[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')  // Words

        const quotedMatches = Array.from(sql.matchAll(pattern))

        if (quotedMatches.length > 0) {
            // Create diagnostic for each match
            for (const match of quotedMatches) {
                diagnostics.push(buildDiagnostic({ document, message, offset: start + match.index, length }))
            }
        }
    }

    finish()
}

function buildUnreachableDiagnostic({
    end, document,
}: {
    end: number,
    document: vscode.TextDocument,
}): vscode.Diagnostic {
    const text = document.getText()
    const unreachableRange = new vscode.Range(document.positionAt(end + 1), document.positionAt(text.length - 1))
    const unreachableDiagnostic = new vscode.Diagnostic(unreachableRange, "Untested statements", vscode.DiagnosticSeverity.Hint)
    unreachableDiagnostic.tags = [vscode.DiagnosticTag.Unnecessary]
    return unreachableDiagnostic
}

export async function lintDocument(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
    const { languageIds, databaseUrl: connectionString } = getConfigManager().get()
    if (!languageIds.includes(document.languageId)) {
        return
    }

    const channel = getChannel()
    channel.clear()

    // collection.clear()
    const sqlText = document.getText()

    const statements = await splitSqlWithPositions(sqlText)
    const postgresConfig: ClientConfig = { connectionString }
    let tempDbConfig: ClientConfig

    const database = `vscode_pglint_${Date.now()}`

    const setupClient = new Client(postgresConfig)

    try {
        channel.appendLine('Connecting to database...')
        await setupClient.connect()
        // channel.appendLine(`postgresConfig: ${JSON.stringify(setupClient)}`)
        channel.appendLine(`Creating temporary database: ${database}`)
        await setupClient.query(`CREATE DATABASE ${database}`)
        tempDbConfig = {
            host: setupClient.host,
            port: setupClient.port,
            user: setupClient.user,
            password: setupClient.password,
            database
        }
        // channel.appendLine(`tempDbConfig: ${JSON.stringify(tempDbConfig)}`)
    } catch (error: any) {
        showMessage(vscode.LogLevel.Error, `Failed to create temporary database: ${database}, url: ${connectionString}`, error)
        return
    } finally {
        await setupClient.end()
    }

    let client = new Client(tempDbConfig)
    try {
        await client.connect()
        const result = await client.query('SELECT current_database();')
        const currentDatabase = result.rows[0].current_database
        if (database !== currentDatabase) {
            throw new Error(`current_database: ${currentDatabase} does not match expected temporary database: ${database}`)
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
            // channel.appendLine(`-- Running statement ${i + 1} of ${length}`)
            const statement = statements[i]
            const { sql, error, start, end } = statement
            if (error) {
                collection.set(document.uri, [
                    buildDiagnostic({
                        document,
                        message: error,
                        offset: start,
                        length: end - start,
                    }),
                    buildUnreachableDiagnostic({ end, document })
                ])
                return
            }

            if (sql) {
                try {
                    await client.query(sql)
                } catch (err: any) {
                    await processError({ document, collection, statement, err })
                    return
                }
            }
        }
    } finally {
        await client.end()
        await cleanupDatabase(postgresConfig, database)
    }
}

async function cleanupDatabase(config: ClientConfig, database: string) {
    const channel = getChannel()
    const cleanupClient = new Client(config)
    try {
        await cleanupClient.connect()
        channel.appendLine('Running cleanup...')
        await cleanupClient.query(`DROP DATABASE IF EXISTS ${database};`)
        channel.appendLine('Cleanup completed')
    } catch (error: any) {
        showMessage(vscode.LogLevel.Error, `Failed to clean up temporary database: ${database}, url: ${config.connectionString}`, error)
    } finally {
        await cleanupClient.end()
    }
}
