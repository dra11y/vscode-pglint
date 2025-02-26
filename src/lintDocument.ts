import * as vscode from 'vscode'
import { EXTENSION_NAME, getChannel, getConfigManager } from './config'
import { clearPositionsCaches, getLastPositionInFile, getLocationFromLength, getPosition, Location, quotedEqual, splitIntoStatements, Statement, TEMPLATE_DIRECTIVE_ERROR_FIRST } from './splitIntoStatements'
import { Client, ClientConfig, QueryResult } from 'pg'
import { showMessage } from './showMessage'
import * as path from 'path'
import { validateDatabaseName } from './validateDatabaseName'

const PLPGSQL_CHECK: string = 'plpgsql_check'
const PLPGSQL_CHECK_FUNCTION_TB: string = 'plpgsql_check_function_tb'
const DOLLAR_QUOTE: RegExp = /\$[^\s]*\$/

/**
 * Translates line/position information from PostgreSQL's compiled function representation
 * to the original user-defined function.
 * 
 * @param row - Information from plpgsql_check extension
 * @param statement - The user-provided statement containing the original SQL
 * @returns Object with start and end positions in the original source
 */
function getRangeInFunction(
    row: CheckFunctionRow,
    statement: Statement
): { start: number, end: number } {
    const { sql } = statement
    if (!sql) {
        throw new Error('No SQL in statement')
    }
    const { query, lineno, position } = row

    // If we have a `query` but no `position`, try to find it in the original SQL.
    // It's not word-accurate, but narrows it down to the given `query`.
    if (position === null && query && query.length > 0) {
        const start = sql.indexOf(query)
        if (start > -1) {
            return { start, end: start + query.length }
        }
    }

    // In plpgsql_check, `lineno`:
    // - is 1-based
    // - 1 starts on `AS $function$`
    // - the function body seems to match, but the header before `AS $function$` is rewritten by Postgres
    const sqlLines = sql.split(/\n/)
    const sqlDollarLine = sqlLines.findIndex(l => DOLLAR_QUOTE.test(l))

    let start = 0
    let end = 0
    const line0 = sqlDollarLine + lineno - 1 // `lineno` is 1-based

    // const deletedLines = sqlLines.splice(0, sqlDollarLine)

    for (let i = 0; i < line0; i++) {
        start += sqlLines[i].length + 1 // newline
    }

    // throw new Error(`lineno: ${lineno}, line0: ${line0}, line: ${sqlLines[line0]}`)

    const line = sqlLines[line0]
    const whitespace = line.length - line.trimStart().length
    start += whitespace

    if (position === null) {
        end = start + line.trim().length
        return { start, end }
    }

    start += position - 1

    const keyword = sql.substring(start).match(/.+?(\b|$)/)![0]!
    end = start + keyword.length

    return { start, end }
}

const CREATE_FUNCTION_REGEX: RegExp = /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+/is
const TABLE_REGEX: RegExp = /@table\s+("([^"]+)"|([^\s]+))/is

const GET_FUNCTION_SIGNATURE_SQL: string = `--sql
SELECT
    l.lanname AS language,
    -- p.oid,
    format_type(p.prorettype, NULL) AS return_type,
    format(
        '%I.%I(%s)',
        n.nspname,
        p.proname,
        array_to_string(
            array(
                SELECT format_type(t.oid, NULL)
                FROM unnest(p.proargtypes) AS t(oid)
            ),
            ', '
        )
    ) AS function_signature
FROM
    pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_language l ON p.prolang = l.oid
WHERE
n.nspname NOT IN('pg_catalog', 'information_schema')
ORDER BY
p.oid DESC
LIMIT 1;`

interface CheckFunctionRow {
    functionid: string
    lineno: number
    statement: string
    sqlstate: string
    message: string
    detail: string | null
    hint: string | null
    level: string
    position: number | null
    query: string | null
    context: string
}

class FunctionError extends Error {
    public position: number
    public hint: string | null

    constructor(position: number, row: CheckFunctionRow) {
        super(row.message)
        this.position = position
        this.hint = row.hint
    }
}

async function checkFunction(statement: Statement, client: Client) {
    const { sql } = statement
    if (!sql || !CREATE_FUNCTION_REGEX.test(sql)) {
        return
    }
    const channel = getChannel()
    let result: QueryResult
    try {
        result = await client.query(GET_FUNCTION_SIGNATURE_SQL)
        if (result.rows[0].language !== 'plpgsql') {
            return
        }
    } catch (e: any) {
        throw new Error('error getting created function')
    }
    const { function_signature, return_type } = result.rows[0]
    const isTrigger = return_type === 'trigger'
    let tableName: string | null = null
    if (isTrigger) {
        const tableMatch = sql.match(TABLE_REGEX)
        if (!tableMatch) {
            throw new Error(`trigger function missing @table annotation:\n${sql}`)
        }
        tableName = tableMatch[2] || tableMatch[3]
    }
    // let source: string
    // try {
    //     const query = `SELECT pg_get_functiondef(${oid})`
    //     result = await client.query(query)
    //     source = result.rows[0].pg_get_functiondef
    // } catch (e: any) {
    //     throw new Error(`error getting function source: $ { e.message } `)
    // }
    let checkResult: QueryResult<CheckFunctionRow>
    try {
        const query = isTrigger ? `SELECT * FROM ${PLPGSQL_CHECK_FUNCTION_TB}($1, $2)` : `SELECT * FROM ${PLPGSQL_CHECK_FUNCTION_TB}($1)`
        const values = isTrigger ? [function_signature, tableName] : [function_signature]
        checkResult = await client.query(query, values)
    } catch (e: any) {
        throw new Error(`error running check query: ${e.message} ${e.hint}, function_signature: ${function_signature}`)
    }
    const { rows } = checkResult
    for (const row of rows) {
        const { start, end } = getRangeInFunction(row, statement)
        const { message, hint, level, context } = row
        throw new FunctionError(start + 1, row)

        // throw new Error(JSON.stringify(row, null, 4) + `\nSOURCE: \n${ source } `)
        // channel.appendLine(`FUNC ERROR: ${ JSON.stringify(row, null, 4) } `)
    }
}

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
        showMessage(vscode.LogLevel.Error, `Failed to terminate backend pid(s) for: ${database} `, error)
    }
}

async function cleanupDatabase(config: ClientConfig, database: string) {
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
        showMessage(vscode.LogLevel.Error, `invalid template name: ${template} `, e)
        return
    }
    const postgresConfig: ClientConfig = { connectionString }
    const client = new Client(postgresConfig)

    try {
        channel.appendLine('Connecting to database...')
        await client.connect()
        await terminateBackend(client, template)
    } catch (error: any) {
        showMessage(vscode.LogLevel.Error, `Failed to terminate template backend connections for: ${template}, url: ${connectionString} `, error)
        return
    } finally {
        await client.end()
    }
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
            await client.query(`CREATE EXTENSION IF NOT EXISTS ${PLPGSQL_CHECK}; `)
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

                let { hint, message }: { hint: string, message: string } = err
                if (hint) {
                    message += ` Hint: ${hint} `
                }
                const { ...error } = { ...err, message }
                const innerOffset = error.position ? parseInt(error.position) - 1 : null

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

                let statementDiagnostic = new vscode.Diagnostic(range, `In this statement: ${message} `, vscode.DiagnosticSeverity.Warning)
                statementDiagnostic.source = EXTENSION_NAME

                const sourceUnreachable = buildUnreachable(statement.location, statementDiagnostic)
                pushDiagnostics(collection, statementUri, [sourceUnreachable])

                channel.appendLine(`ERROR: ${JSON.stringify(error)} `)

                // TODO: improve when postgres returns a quoted quote (""something"")
                const quotedMatch = message.match(/column ([^\s]+)|\"([^"]+)\"/)
                const quoted = quotedMatch?.[1] ?? quotedMatch?.[2] ?? null

                if (innerOffset !== null && !isNaN(innerOffset)) {
                    const rest = sql.substring(innerOffset)
                    let length: number
                    if (quoted) {
                        length = rest.indexOf(quoted) + quoted.length
                        channel.appendLine(`INNER OFFSET: ${innerOffset}, quoted: ${quoted}, length: ${length} `)
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

                        channel.appendLine(`includeDiagnostic: ${JSON.stringify(includedDiagnostic)} `)

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

                channel.appendLine(`${i}: ERROR @${JSON.stringify(statement.location)}: ${JSON.stringify(err)} `)
                return
            }
        }
    } finally {
        await client.end()
        await cleanupDatabase(postgresConfig, database)
    }
}
