import * as vscode from 'vscode'
import { getLastPositionInFile, getLocationFromLength, getPosition, Location, Statement } from './splitIntoStatements'
import { EXTENSION_NAME, getChannel, getConfigManager } from './config'
import { DatabaseError } from 'pg'

function attachMessageToDatabaseError(error: any): any {
    if (error instanceof DatabaseError) {
        return {
            ...error,
            isDatabaseError: true,
            message: error.message,
        }
    }
    return error
}

export class GeneralError extends Error {
    public severity: vscode.DiagnosticSeverity

    constructor({
        message, cause, severity,
    }: {
        message: string
        cause?: unknown
        severity?: vscode.DiagnosticSeverity
    }) {
        super(message, { cause })
        this.severity = severity ?? vscode.DiagnosticSeverity.Error
    }

    public handleShouldContinue(collection: vscode.DiagnosticCollection): boolean {
        const channel = getChannel()
        channel.appendLine(`ERROR: ${JSON.stringify(this, null, 4)}`)
        return true
    }

    toJSON(): object {
        const cause = attachMessageToDatabaseError(super.cause)
        const severity = vscode.DiagnosticSeverity[this.severity]
        return {
            severity,
            message: this.message,
            cause,
        }
    }
}

export class ConfigError extends GeneralError {
    public key: String
    public value: any

    constructor({
        message, key, value, cause, severity,
    }: {
        message: string
        key: string
        value: any
        cause?: unknown
        severity?: vscode.DiagnosticSeverity
    }) {
        super({ message: `${message} in config ${key} = ${value}`, cause, severity })
        this.key = key
        this.value = value
    }

    toJSON(): object {
        return {
            ...super.toJSON(),
            key: this.key,
            value: this.value,
        }
    }
}

export class StatementError extends GeneralError {
    public statement: Statement
    /// The database error that caused the statement to be invalid.
    public error: Error

    constructor({
        statement, message, error, severity,
    }: {
        statement: Statement
        message: string
        error: Error
        severity?: vscode.DiagnosticSeverity
    }) {
        super({
            message,
            cause: error,
            severity,
        })
        this.statement = statement
        this.error = error
    }

    toJSON(): object {
        const error = attachMessageToDatabaseError(this.error)
        return {
            ...super.toJSON(),
            error,
            statement: this.statement,
        }
    }

    public handleShouldContinue(collection: vscode.DiagnosticCollection): boolean {
        super.handleShouldContinue(collection)
        const channel = getChannel()
        const { warnWholeStatement } = getConfigManager().get()
        const error = this.error as DatabaseError
        const { message, position, hint } = error
        const messageWithHint = hint ? `${message}; Hint: ${hint}` : message
        const {
            statement,
            statement: {
                location,
                location: {
                    startOffset,
                    uri,
                    range,
                }
            }
        } = this
        const sql = statement.sql!
        let innerOffset = position ? parseInt(position) - 1 : null

        let includedDiagnostic: vscode.Diagnostic | null = null
        const { includedAt } = statement
        if (includedAt) {
            includedDiagnostic = new vscode.Diagnostic(includedAt.range, `In included file: ${message} `, vscode.DiagnosticSeverity.Error)
            includedDiagnostic.source = EXTENSION_NAME

            const related = new vscode.DiagnosticRelatedInformation(
                new vscode.Location(uri, range),
                message,
            )
            includedDiagnostic.relatedInformation = [related]
        }

        let statementDiagnostic = new vscode.Diagnostic(range, `In this statement: ${message}}`, vscode.DiagnosticSeverity.Warning)
        statementDiagnostic.source = EXTENSION_NAME

        const sourceUnreachable = buildUnreachable(location, statementDiagnostic)
        pushDiagnostics(collection, uri, [sourceUnreachable])

        const quotedMatch = message.match(/operator does not exist: \w+\s+([^\s]+)|column "?((?:[^"]+))"?|(?:.*)"([^"]+)"(?!.*")/)
        const quoted = quotedMatch?.[1] ?? quotedMatch?.[2] ?? quotedMatch?.[3] ?? null
        channel.appendLine(`quotedMatch: ${quotedMatch}|message: ${message}`)

        if (quoted || (innerOffset !== null && !isNaN(innerOffset))) {
            const rest = sql.substring(innerOffset ?? 0)
            let length = 1
            if (quoted) {
                const quotedOffset = Math.max(
                    rest.indexOf(quoted),
                    rest.toLowerCase().indexOf(quoted)
                )
                channel.appendLine(`innerOffset: ${innerOffset}, quoted: ${quoted}, quotedOffset: ${quotedOffset}, rest: ${rest}`)

                if (quotedOffset > -1) {
                    if (innerOffset) {
                        innerOffset += quotedOffset
                    } else {
                        innerOffset = quotedOffset
                    }
                }
                length = quoted.length
            } else {
                const innerEnd = rest.match(/[^a-z0-9_"]|$/i)!
                channel.appendLine(`innerEnd: ${innerEnd}`)
                length = innerEnd.index!
            }
            length = Math.max(1, length)

            const innerLocation = getLocationFromLength(uri, startOffset + (innerOffset ?? 0), length)
            let innerDiagnostic = new vscode.Diagnostic(innerLocation.range, messageWithHint, vscode.DiagnosticSeverity.Error)
            innerDiagnostic.source = EXTENSION_NAME

            pushDiagnostics(collection, uri, [innerDiagnostic])
            if (warnWholeStatement) {
                pushDiagnostics(collection, uri, [statementDiagnostic])
            }

            if (includedAt && includedDiagnostic) {
                const related = new vscode.DiagnosticRelatedInformation(
                    new vscode.Location(uri, innerLocation.range),
                    message,
                )
                includedDiagnostic.relatedInformation = [related]

                channel.appendLine(`includeDiagnostic: ${JSON.stringify(includedDiagnostic)} `)

                const includeUnreachable = buildUnreachable(includedAt, includedDiagnostic)

                pushDiagnostics(collection, includedAt.uri, [includedDiagnostic, includeUnreachable])
            }

            return false
        }

        statementDiagnostic.severity = vscode.DiagnosticSeverity.Error
        statementDiagnostic.message = messageWithHint
        pushDiagnostics(collection, uri, [statementDiagnostic])

        if (statement.includedAt && includedDiagnostic) {
            pushDiagnostics(collection, statement.includedAt.uri, [includedDiagnostic])
        }

        // channel.appendLine(`ERROR @${JSON.stringify(statement.location)}: ${JSON.stringify(error)}`)
        return false
    }
}

export function handleErrorShouldContinue(error: any, collection: vscode.DiagnosticCollection): boolean {
    if (error instanceof GeneralError) {
        return error.handleShouldContinue(collection)
    }
    const unhandled = new GeneralError({
        message: 'error not handled',
        cause: error,
    })
    unhandled.handleShouldContinue(collection)
    return false
}

export function handleError(error: any, collection: vscode.DiagnosticCollection): void {
    handleErrorShouldContinue(error, collection)
}

export function pushDiagnostics(collection: vscode.DiagnosticCollection, uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) {
    const existing = collection.get(uri) ?? []
    collection.set(uri, [...existing, ...diagnostics])
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
