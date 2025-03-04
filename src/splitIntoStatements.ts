import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'
import { getChannel } from './config'
import { validateDatabaseName } from './validateDatabaseName'

const TEMPLATE_PREFIX: RegExp = /^@template(:|\s)/
const INCLUDE_PREFIX: RegExp = /^@include(:|\s)/
export const TEMPLATE_DIRECTIVE_ERROR_FIRST: string = 'Only one template directive is allowed, and it must come before any other statements.'

let LINE_STARTS_CACHE: Map<vscode.Uri, number[]> = new Map()
let FILE_LENGTHS_CACHE: Map<vscode.Uri, number> = new Map()

interface IncludeFile {
    includeUri: vscode.Uri
    text: string
}

function positionToString(position: vscode.Position) {
    const { line, character } = position
    return `[${line}:${character}]`
}

function rangeToString(range: vscode.Range) {
    const [start, end] = [positionToString(range.start), positionToString(range.end)]
    return `${start}-${end}`
}

export class Location extends vscode.Location {
    public startOffset: number
    public length: number

    constructor({
        uri,
        range,
        startOffset,
        length,
    }: {
        uri: vscode.Uri,
        range: vscode.Range,
        startOffset: number,
        length: number,
    }) {
        super(uri, range)
        this.startOffset = startOffset
        this.length = length
    }

    toJSON() {
        const uri = this.uri.toString()
        const range = rangeToString(this.range)
        const {
            startOffset,
            length,
        } = this
        return {
            uri,
            range,
            startOffset,
            length,
        }
    }
}

export class Statement {
    public includedAt?: Location
    public location: Location
    public sql?: string
    public error?: string
    public template?: string

    constructor({
        includedAt,
        location,
        sql,
        error,
        template,
    }: {
        includedAt?: Location,
        location: Location,
        sql?: string,
        error?: string,
        template?: string,
    }) {
        this.includedAt = includedAt
        this.location = location
        this.sql = sql
        this.error = error
        this.template = template
    }

    toJSON() {
        const {
            includedAt,
            location,
            sql,
            template,
            error,
        } = this
        return {
            sql,
            template,
            error,
            includedAt,
            location,
        }
    }
}

export function quote(s: string) {
    return s.startsWith('"') ? s : `"${s}"`
}

export function quotedEqual(a: string, b: string) {
    return quote(a) === quote(b)
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

    const starts = LINE_STARTS_CACHE.get(uri)
    if (!starts) {
        throw new Error(`lineStarts cache missing for uri: ${uri}`)
    }
    const filtered = starts.filter(s => s <= offset)
    const line = filtered.length
    const lineStart = line > 0 ? filtered[line - 1] : 0
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
    return new Location({
        uri,
        range,
        startOffset,
        length,
    })
}

export function getLocationFromLength(uri: vscode.Uri, startOffset: number, length: number): Location {
    return getLocationFromEndOffset(uri, startOffset, startOffset + length)
}

/// `directive` is the string **after** the `INCLUDE_PREFIX` is removed.
/// throws
async function tryInclude(directive: string, uri: vscode.Uri): Promise<IncludeFile> {
    if (!directive.trim()) {
        throw new Error('include directive must be a non-empty string')
    }
    const channel = getChannel()
    const normalizedDirective = path.normalize(directive.trim())
    const dirPath = path.dirname(uri.fsPath)
    const resolvedPath = path.resolve(dirPath, normalizedDirective)
    channel.appendLine(`directive: ${directive}\nnormalizedDirective: ${normalizedDirective}\ndirPath: ${dirPath}\nresolvedPath: ${resolvedPath}`)
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
    let isBlockComment = false
    let isStatement = false

    const pushStatement = (endOffset: number) => {
        if (currentSql.trim()) {
            const location = getLocationFromEndOffset(uri, currentStart, endOffset)
            statements.push(new Statement({
                location,
                sql: currentSql,
            }))
        }
        currentStart = endOffset + 1
        currentSql = ''
    }

    const length = sql.length
    while (offset < length) {
        const char = sql[offset]
        const nextChar = offset < length - 1 ? sql[offset + 1] : ''

        // Handle block comments
        if (isBlockComment) {
            if (char === '*' && nextChar === '/') {
                isBlockComment = false
                offset++
            }
            offset++
            continue
        }

        // Process between statements
        if (!isStatement) {
            // Skip whitespace between statements
            if (/[\s\r\n]/.test(char)) {
                offset++
                continue
            }

            // Check for line comment start (--)
            if (char === '-' && nextChar === '-') {
                // Process line comment directive
                offset += 2
                const commentLine = sql.substring(offset).match(/[^\r\n]*(\r?\n|$)/)?.[0] ?? ''
                let commentText = commentLine.trimStart()
                const startOffset = offset + (commentLine.length - commentText.length)
                commentText = commentText.trimEnd()
                offset += commentLine.length

                if (!INCLUDE_PREFIX.test(commentText) && !TEMPLATE_PREFIX.test(commentText)) {
                    continue
                }

                const location = getLocationFromLength(uri, startOffset, commentText.length)
                const directive = commentText
                    .replace(INCLUDE_PREFIX, '')
                    .replace(TEMPLATE_PREFIX, '')

                if (INCLUDE_PREFIX.test(commentText)) {
                    try {
                        const { includeUri, text } = await tryInclude(directive, uri)
                        let includeStatements = await splitIntoStatements(includeUri, text)
                        for (let includeStatement of includeStatements) {
                            includeStatement.includedAt = location
                        }
                        statements.push(...includeStatements)
                    } catch (e: any) {
                        statements.push(new Statement({
                            location,
                            error: e.message ?? 'invalid include directive',
                        }))
                        return statements
                    }
                    continue
                }

                if (TEMPLATE_PREFIX.test(commentText)) {
                    const template = directive.trim()

                    try {
                        validateDatabaseName(template)
                    } catch (e: any) {
                        statements.push(new Statement({
                            location,
                            error: e.message ?? 'invalid template directive',
                        }))
                        return statements
                    }

                    if (statements.length > 0) {
                        const templateStatements = statements.filter(s => !!s.template)
                        if (templateStatements.length > 0 && templateStatements.some(s => !quotedEqual(template, s.template!))) {
                            statements.push(new Statement({
                                location,
                                error: TEMPLATE_DIRECTIVE_ERROR_FIRST,
                            }))
                            return statements
                        }
                    }

                    statements.push(new Statement({
                        location,
                        template,
                    }))
                    continue
                }
                continue
            }

            // Check for block comment start (/*)
            if (char === '/' && nextChar === '*') {
                isBlockComment = true
                offset += 2
                continue
            }

            // Start new statement
            currentStart = offset
            isStatement = true
        }

        // Handle the statement
        if (isStatement) {
            // Check for quotes
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

            // Regular character
            currentSql += char
            offset++
        }
    }

    // Add final statement
    if (currentSql.trim()) {
        pushStatement(offset - 1)
    }

    return statements
}
