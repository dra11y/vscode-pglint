import * as vscode from 'vscode'
import { getChannel, EXTENSION_NAME } from './config'

export function showMessage(logLevel: vscode.LogLevel = vscode.LogLevel.Error, message: string, error?: any) {
    const details = error?.message ? `: ${error.message}` : (error ? `: ${JSON.stringify(error)}` : '')
    const fullMessage = `${EXTENSION_NAME}: ${message}${details}`
    const level = vscode.LogLevel[logLevel]

    switch (logLevel) {
        case vscode.LogLevel.Error:
            vscode.window.showErrorMessage(fullMessage)
            break
        case vscode.LogLevel.Warning:
            vscode.window.showWarningMessage(fullMessage)
            break
        default:
            vscode.window.showInformationMessage(fullMessage)
    }
    getChannel().appendLine(`${level}: ${fullMessage}`)
}
