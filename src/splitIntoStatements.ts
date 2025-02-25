import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'
import { getChannel } from './config'

const INCLUDE_PREFIX: string = '@include:'

let LINE_STARTS_CACHE: Map<vscode.Uri, number[]> = new Map()
let FILE_LENGTHS_CACHE: Map<vscode.Uri, number> = new Map()

interface IncludeFile {
    includeUri: vscode.Uri
    text: string
}

export interface Location {
    uri: vscode.Uri
    range: vscode.Range
    startOffset: number
    length: number
}

export interface Statement {
    includedAt?: Location
    location: Location
    sql?: string
    error?: string
}

export function clearPositionsCaches() {
    LINE_STARTS_CACHE.clear()
    FILE_LENGTHS_CACHE.clear()
}

function cacheLineStarts(uri: vscode.Uri, text: string) {
    if (LINE_STARTS_CACHE.has(uri)) {
        return
    }
    FILE_LENGTHS_CACHE.set(uri, text.length)
    const length = text.length
    // line numbers are 0-based in vscode
    let starts = []
    for (let i = 0; i < length; i++) {
        if (text[i] === '\n') {
            starts.push(i + 1)
        } else if (text[i] === '\r' && text.length > i + 1 && text[i + 1] === '\n') {
            starts.push(i + 2)
            i++
        }
    }
    LINE_STARTS_CACHE.set(uri, starts)
}

export function getLastPositionInFile(uri: vscode.Uri): vscode.Position {
    const length = FILE_LENGTHS_CACHE.get(uri)
    if (!length) {
        throw new Error(`no length in cache for ${uri.toString()}`)
    }
    return getPosition(uri, length - 1)
}

export function getPosition(uri: vscode.Uri, offset: number): vscode.Position {
    const channel = getChannel()
    // channel.appendLine(`getPosition(...${offset})`)

    const starts = LINE_STARTS_CACHE.get(uri)
    if (!starts) {
        throw new Error(`lineStarts cache missing for uri: ${uri}`)
    }
    const filtered = starts.filter(s => s <= offset)
    const line = filtered.length
    const lineStart = filtered[line - 1]
    // channel.appendLine(`getPosition line: ${line}, character: ${offset - lineStart}`)

    return new vscode.Position(line, offset - lineStart)
}

export function getLocationFromEndOffset(uri: vscode.Uri, startOffset: number, endOffset: number): Location {
    const channel = getChannel()
    // channel.appendLine(`getLocation(...${startOffset}, ${endOffset})`)
    const start = getPosition(uri, startOffset)
    const end = getPosition(uri, endOffset)
    const range = new vscode.Range(start, end)
    const length = endOffset - startOffset
    return {
        uri,
        range,
        startOffset,
        length,
    }
}

export function getLocationFromLength(uri: vscode.Uri, startOffset: number, length: number): Location {
    return getLocationFromEndOffset(uri, startOffset, startOffset + length)
}

/// `directive` is the string **after** the `INCLUDE_PREFIX` is removed.
/// throws
async function tryInclude(directive: string, uri: vscode.Uri): Promise<IncludeFile> {
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
    const text = file.toString()
    return {
        includeUri,
        text,
    }
}

export async function splitIntoStatements(uri: vscode.Uri, sql: string): Promise<Statement[]> {
    const channel = getChannel()
    cacheLineStarts(uri, sql)
    let statements: Statement[] = []
    let currentStart = 0
    let currentSql = ''

    let offset = 0
    let quoteChar: string | null = null
    let isLineComment = false
    let isBlockComment = false
    let isStatement = false

    const pushStatement = (endOffset: number) => {
        if (currentSql.trim()) {
            const location = getLocationFromEndOffset(uri, currentStart, endOffset)
            statements.push({
                location,
                sql: currentSql,
            })
        }
        currentStart = endOffset + 1
        currentSql = ''
    }

    const length = sql.length
    while (offset < length) {
        const char = sql[offset]
        const nextChar = offset < length - 1 ? sql[offset + 1] : ''

        // Handle line comments
        if (isLineComment) {
            isStatement = false
            if (char === '\n') {
                isLineComment = false
            }
            offset++
            continue
        }

        // Handle block comments
        if (isBlockComment) {
            isStatement = false
            if (char === '*' && nextChar === '/') {
                isBlockComment = false
                offset++
            }
            offset++
            continue
        }

        // Skip whitespace between statements
        if (!isStatement && /[\s\r\n]/.test(char)) {
            offset++
            continue
        }

        // If not whitespace or inside a comment:
        // - we've entered a statement;
        // - store the start position of the statement.
        if (!isStatement) {
            currentStart = offset
            isStatement = true
        }

        // Check for line comment start
        if (char === '-' && nextChar === '-') {
            isLineComment = true
            isStatement = false
            offset += 2
            const newline = sql.indexOf('\n', offset)
            if (newline > -1) {
                while (/[\s\r\n]/.test(sql[offset])) {
                    offset++
                }
                const commentText = sql.substring(offset, newline).trim()
                if (!commentText.startsWith(INCLUDE_PREFIX)) {
                    continue
                }

                const directive = commentText.replace(INCLUDE_PREFIX, '')
                const location = getLocationFromLength(uri, offset, commentText.length)
                try {
                    const { includeUri, text } = await tryInclude(directive, uri)
                    let includeStatements = await splitIntoStatements(includeUri, text)
                    for (let includeStatement of includeStatements) {
                        includeStatement.includedAt = location
                    }
                    statements.push(...includeStatements)
                } catch (e: any) {
                    statements.push({
                        location,
                        error: e.message ?? 'invalid include directive',
                    })
                    return statements
                }
            }
            continue
        }

        // Check for block comment start
        if (char === '/' && nextChar === '*') {
            isBlockComment = true
            isStatement = false
            offset += 2
            continue
        }

        // Handle quotes
        if (quoteChar) {
            currentSql += char
            if (char === quoteChar) {
                quoteChar = null
            }
            offset++
            continue
        }

        // Check for dollar quote start
        if (char === '$') {
            const slice = sql.slice(offset)
            const match = slice.match(/^\$([A-Za-z\u0080-\uffff_][A-Za-z\u0080-\uffff0-9_]*)?\$/)
            if (match) {
                const dollarTag = match[0] || '$$'

                const endTagPos = slice.substring(dollarTag.length).indexOf(dollarTag)
                if (endTagPos > -1) {
                    const quotedText = slice.substring(0, endTagPos + dollarTag.length * 2)
                    currentSql += quotedText
                    offset += quotedText.length
                    continue
                }
            }
        }

        // Check for quote starts
        if (['"', "'", '`'].includes(char)) {
            quoteChar = char
            currentSql += char
            offset++
            continue
        }

        // Split on semicolons
        if (char === ';') {
            currentSql += char
            pushStatement(offset)
            isStatement = false
            offset++
            continue
        }

        // Regular character?
        currentSql += char
        offset++
    }

    // Add final statement
    if (currentSql.trim()) {
        pushStatement(offset - 1)
    }

    return statements
}
