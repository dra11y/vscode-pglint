import { Client, QueryResult } from 'pg'
import { getChannel } from './config'
import { Statement } from './splitIntoStatements'

const PLPGSQL_CHECK: string = 'plpgsql_check'

export const CREATE_EXTENSION_PLPGSQL_CHECK: string = `CREATE EXTENSION IF NOT EXISTS ${PLPGSQL_CHECK};`
export const CREATE_FUNCTION_REGEX: RegExp = /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+/is

const PLPGSQL_CHECK_FUNCTION_TB: string = 'plpgsql_check_function_tb'
const DOLLAR_QUOTE: RegExp = /\$[^\s]*\$/

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

async function getCompiledFunctionDefinition(client: Client, functionSignature: string): Promise<string> {
    try {
        const query = `SELECT pg_get_functiondef($1::regclass::oid)`
        const result = await client.query(query, [functionSignature])
        return result.rows[0].pg_get_functiondef
    } catch (e: any) {
        throw new Error(`error getting function source: $ { e.message } `)
    }
}

export async function checkFunction(statement: Statement, client: Client) {
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
    }
}

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
