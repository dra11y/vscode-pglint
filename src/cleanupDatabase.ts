import { ClientConfig, Client } from 'pg'
import * as vscode from 'vscode'
import { getChannel, getConfigManager } from './config'
import { showMessage } from './showMessage'

export async function cleanupDatabase(database: string) {
    const channel = getChannel()
    const { databaseUrl } = getConfigManager().get()
    const cleanupClient = new Client(databaseUrl)
    try {
        await cleanupClient.connect()
        channel.appendLine('Running cleanup...')
        await cleanupClient.query(`DROP DATABASE IF EXISTS "${database}"; `)
        channel.appendLine('Cleanup completed')
    } catch (error: any) {
        showMessage(vscode.LogLevel.Error, `Failed to clean up temporary database: ${database}, url: ${databaseUrl} `, error)
    } finally {
        await cleanupClient.end()
    }
}
