import { ClientConfig, Client, QueryResult } from 'pg'
import { getConfigManager, getChannel, ConfigKey, EXTENSION_NAME } from './config'
import { StatementError } from './errors'
import { ConfigError } from './errors'
import { GeneralError } from './errors'
import { Statement } from './splitIntoStatements'
import { terminateBackend } from './terminateBackend'
import { validateDatabaseName } from './validateDatabaseName'

export async function createTempDatabase(templateStatement?: Statement): Promise<ClientConfig> {
    const channel = getChannel()

    const config = getConfigManager().get()

    const template = templateStatement?.template

    if (template) {
        try {
            validateDatabaseName(template)
        } catch (error: any) {
            throw new StatementError({ message: `invalid template name: ${template}`, statement: templateStatement, error })
        }
    }

    const databasePrefix = config.tempDatabasePrefix.replace(/(^|[^"])"([^"]|$)/g, '$1""$2')

    const database = `${databasePrefix}${Date.now()} `
    const quotedDatabase = `"${database}"`
    try {
        validateDatabaseName(quotedDatabase)
    } catch (error: any) {
        throw new ConfigError({
            message: `invalid database prefix`,
            key: ConfigKey.tempDatabasePrefix,
            value: config.tempDatabasePrefix,
            cause: error,
        })
    }

    let sql = `CREATE DATABASE ${quotedDatabase}`
    if (template) {
        if (config.autoTerminateTemplateConnections) {
            await terminateBackend(template)
        }
        sql += ` TEMPLATE ${template}`
    }
    channel.appendLine(`creating temp db...`)

    const client = new Client(config.databaseUrl)

    try {
        channel.appendLine('Connecting to Postgres...')
        await client.connect()
        channel.appendLine(`Creating temporary database: ${quotedDatabase}`)
        await client.query(sql)
        return {
            host: client.host,
            port: client.port,
            user: client.user,
            password: client.password,
            database
        }
    } catch (error: any) {
        if (template) {
            let { message } = error
            if (message.includes('is being accessed by other users')) {
                message += ` (You can set ${EXTENSION_NAME}.${ConfigKey.autoTerminateTemplateConnections} = true in settings to auto-terminate. WARNING! This will kill any active connections and queries on the template database.)`
            }
            throw new StatementError({
                message,
                statement: new Statement({
                    ...templateStatement,
                    sql
                }),
                error,
            })
        }

        throw new GeneralError({
            message: `Failed to create temporary database: ${database}, url: ${config.databaseUrl}, sql: ${sql}`,
            cause: error,
        })
    } finally {
        await client.end()
    }
}
