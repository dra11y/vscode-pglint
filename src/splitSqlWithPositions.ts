import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'

export interface Statement {
    uri: vscode.Uri
    sql?: string
    error?: string
    start: number
    end: number
}

interface IncludeSql {
    includeUri: vscode.Uri
    includeSql: string
}

const INCLUDE_PREFIX: string = '@include:'

/// `directive` is the string **after** the `INCLUDE_PREFIX` is removed.
/// throws
async function tryInclude(directive: string, uri: vscode.Uri): Promise<IncludeSql> {
    if (!directive) {
        throw new Error('include directive must be a non-empty string')
    }
    // Normalize the directive path to handle any path format issues
    // This resolves '.', removes redundant separators, etc.
    const normalizedDirective = path.normalize(directive)
    // Get the parent directory of the current uri
    const dirPath = path.dirname(uri.fsPath)
    // Resolve the directive relative to the directory
    const resolvedPath = path.join(dirPath, normalizedDirective)
    const stat = await fs.stat(resolvedPath)
    if (!stat.isFile()) {
        throw new Error(`include path is not a file: ${resolvedPath}`)
    }
    const includeUri = vscode.Uri.file(resolvedPath)
    const file = await fs.readFile(resolvedPath)
    const includeSql = file.toString()
    return {
        includeSql,
        includeUri
    }
}

export async function splitSqlWithPositions(uri: vscode.Uri, sql: string): Promise<Statement[]> {
    const statements: Statement[] = []
    let currentStart = 0
    let currentText = ''

    let pos = 0
    let quoteChar: string | null = null
    let isLineComment = false
    let isBlockComment = false
    let isStatement = false

    const pushStatement = (endPos: number) => {
        if (currentText.trim()) {
            statements.push({
                uri,
                sql: currentText,
                start: currentStart,
                end: endPos
            })
        }
        currentStart = endPos + 1
        currentText = ''
    }

    while (pos < sql.length) {
        const char = sql[pos]
        const nextChar = sql[pos + 1]

        // Handle line comments
        if (isLineComment) {
            isStatement = false
            if (char === '\n') {
                isLineComment = false
            }
            pos++
            continue
        }

        // Handle block comments
        if (isBlockComment) {
            isStatement = false
            if (char === '*' && nextChar === '/') {
                isBlockComment = false
                pos++
            }
            pos++
            continue
        }

        // Skip whitespace between statements
        if (!isStatement && /[\s\r\n]/.test(char)) {
            pos++
            continue
        }

        // If not whitespace or inside a comment:
        // - we've entered a statement;
        // - store the start position of the statement.
        if (!isStatement) {
            currentStart = pos
            isStatement = true
        }

        // Check for line comment start
        if (char === '-' && nextChar === '-') {
            isLineComment = true
            isStatement = false
            pos += 2
            const newline = sql.indexOf('\n', pos)
            if (newline > -1) {
                while (/[\s\r\n]/.test(sql[pos])) {
                    pos++
                }
                const commentText = sql.substring(pos, newline).trim()
                if (!commentText.startsWith(INCLUDE_PREFIX)) {
                    continue
                }

                const directive = commentText.replace(INCLUDE_PREFIX, '')
                try {
                    const { includeUri, includeSql } = await tryInclude(directive, uri)
                    statements.push(...await splitSqlWithPositions(includeUri, includeSql))

                } catch (e: any) {
                    statements.push({
                        uri,
                        error: e.message ?? 'invalid include directive',
                        start: pos,
                        end: pos + commentText.length
                    })
                }
            }
            continue
        }

        // Check for block comment start
        if (char === '/' && nextChar === '*') {
            isBlockComment = true
            isStatement = false
            pos += 2
            continue
        }

        // Handle quotes
        if (quoteChar) {
            currentText += char
            if (char === quoteChar) {
                quoteChar = null
            }
            pos++
            continue
        }

        // Check for dollar quote start
        if (char === '$') {
            const slice = sql.slice(pos)
            const match = slice.match(/^\$([A-Za-z\u0080-\uffff_][A-Za-z\u0080-\uffff0-9_]*)?\$/)
            if (match) {
                const dollarTag = match[0] || '$$'

                const endTagPos = slice.substring(dollarTag.length).indexOf(dollarTag)
                if (endTagPos > -1) {
                    const quotedText = slice.substring(0, endTagPos + dollarTag.length * 2)
                    currentText += quotedText
                    pos += quotedText.length
                    continue
                }
            }
        }

        // Check for quote starts
        if (['"', "'", '`'].includes(char)) {
            quoteChar = char
            currentText += char
            pos++
            continue
        }

        // Split on semicolons
        if (char === ';') {
            currentText += char
            pushStatement(pos)
            isStatement = false
            pos++
            continue
        }

        // Regular character?
        currentText += char
        pos++
    }

    // Add final statement
    if (currentText.trim()) {
        statements.push({
            uri,
            sql: currentText,
            start: currentStart,
            end: pos - 1
        })
    }

    return statements
}
