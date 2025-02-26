import { ClientConfig, Client } from 'pg'
import * as vscode from 'vscode'
import { getChannel } from './config'
import { showMessage } from './showMessage'

export async function cleanupDatabase(config: ClientConfig, database: string) {
    const channel = getChannel()
    const cleanupClient = new Client(config)
    try {
        await cleanupClient.connect()
        channel.appendLine('Running cleanup...')
        await cleanupClient.query(`DROP DATABASE IF EXISTS "${database}"; `)
        channel.appendLine('Cleanup completed')
    } catch (error: any) {
        showMessage(vscode.LogLevel.Error, `Failed to clean up temporary database: ${database}, url: ${config.connectionString} `, error)
    } finally {
        await cleanupClient.end()
    }
}
