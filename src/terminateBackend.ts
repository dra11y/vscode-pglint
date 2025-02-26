import * as vscode from 'vscode'
import { Client, ClientConfig } from 'pg'
import { getChannel, getConfigManager } from './config'
import { showMessage } from './showMessage'
import { splitIntoStatements } from './splitIntoStatements'
import { validateDatabaseName } from './validateDatabaseName'

export async function terminateBackend(database: string) {
    const channel = getChannel()

    const config = getConfigManager().get()

    const sql = `--sql
        SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = '${database}' AND pid <> pg_backend_pid();`

    const client = new Client(config.databaseUrl)

    try {
        await client.connect()
        channel.appendLine(`Terminating any active connections to ${database} ...`)
        await client.query(sql)
        channel.appendLine('Terminate completed')
    } catch (error: any) {
        showMessage(vscode.LogLevel.Error, `Failed to terminate backend pid(s) for: ${database} `, error)
    }
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
        showMessage(vscode.LogLevel.Error, `invalid template name: ${template} `, e)
        return
    }
    const postgresConfig: ClientConfig = { connectionString }
    const client = new Client(postgresConfig)

    try {
        channel.appendLine('Connecting to database...')
        await terminateBackend(template)
    } catch (error: any) {
        showMessage(vscode.LogLevel.Error, `Failed to terminate template backend connections for: ${template}, url: ${connectionString} `, error)
        return
    } finally {
        await client.end()
    }
}

