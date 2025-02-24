
import * as vscode from 'vscode'
import { splitSqlWithPositions, Statement } from './splitSqlWithPositions'
import { Client, ClientConfig } from 'pg'
import { getChannel, getConfigManager } from './config'
import { showMessage } from './showMessage'

export async function lintDocument(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
    const { languageIds, databaseUrl: connectionString } = getConfigManager().get()
    if (!languageIds.includes(document.languageId)) {
        return
    }

    const channel = getChannel()

    collection.delete(document.uri)
    const sqlText = document.getText()
    const diagnostics: vscode.Diagnostic[] = []

    const statements = splitSqlWithPositions(sqlText)
    const postgresConfig: ClientConfig = { connectionString }
    let tempDbConfig: ClientConfig

    const database = `vscode_pglint_${Date.now()}`

    const setupClient = new Client(postgresConfig)

    try {
        channel.appendLine('Connecting to database...')
        await setupClient.connect()
        channel.appendLine(`postgresConfig: ${JSON.stringify(setupClient)}`)
        channel.appendLine(`Creating temporary database: ${database}`)
        await setupClient.query(`CREATE DATABASE ${database}`)
        tempDbConfig = {
            host: setupClient.host,
            port: setupClient.port,
            user: setupClient.user,
            password: setupClient.password,
            database
        }
        channel.appendLine(`tempDbConfig: ${JSON.stringify(tempDbConfig)}`)
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

    let statement!: Statement

    try {
        const length = statements.length
        for (var i = 0; i < length; i++) {
            channel.appendLine(`-- Running statement ${i + 1} of ${length}`)
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
        const offset = error.position ? parseInt(error.position) - 1 : null
        channel.appendLine(`ERROR: ${message} - ${JSON.stringify(error)}`)

        const { sql, start, end } = statement
        const statementRange = new vscode.Range(document.positionAt(start), document.positionAt(end))
        let statementDiagnostic = new vscode.Diagnostic(statementRange, message, vscode.DiagnosticSeverity.Error)

        const pushDiagnostic = ({ offset, length }: { offset: number, length: number }) => {
            const errorRange = new vscode.Range(
                document.positionAt(start + offset),
                document.positionAt(start + offset + length)
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

        const quoted = message.match(/\"([^"]+)\"/)
        if (quoted) {
            const length = quoted[1].length
            if (offset && offset < sql.length - quoted[1].length) {
                pushDiagnostic({ offset, length })
            } else {
                const pattern = quoted[1].match(/^[^a-zA-Z0-9]+$/)
                    ? new RegExp(quoted[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')  // Special chars
                    : new RegExp(`\\b${quoted[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')  // Words

                const quotedMatches = Array.from(sql.matchAll(pattern))

                if (quotedMatches.length > 0) {
                    // Create diagnostic for each match
                    for (const match of quotedMatches) {
                        const offset = match.index
                        pushDiagnostic({ offset, length })
                    }
                }
            }
        } else if (offset && offset < sql.length - 1) {
            const word = sql.substring(offset).match(/\b|$/)
            const length = word?.index ?? sql.length - offset
            pushDiagnostic({ offset, length })
        }
        diagnostics.push(statementDiagnostic)

        const unreachableRange = new vscode.Range(document.positionAt(end + 1), document.positionAt(sqlText.length))
        const unreachableDiagnostic = new vscode.Diagnostic(unreachableRange, "Untested statements", vscode.DiagnosticSeverity.Hint)
        unreachableDiagnostic.tags = [vscode.DiagnosticTag.Unnecessary]
        diagnostics.push(unreachableDiagnostic)
        collection.set(document.uri, diagnostics)
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
