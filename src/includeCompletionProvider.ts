import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'

export class IncludeCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.CompletionItem[] | Thenable<vscode.CompletionItem[]> {
        const linePrefix = document.lineAt(position).text.substr(0, position.character)
        if (!linePrefix.match(/--\s*@include[:\s]\s*/)) {
            return []
        }

        const dirPath = path.dirname(document.uri.fsPath)
        const includePath = linePrefix.match(/--\s*@include[:\s]\s*([^\s]*)$/)?.[1] ?? ''
        const resolvedPath = path.resolve(dirPath, includePath)

        return new Promise((resolve, reject) => {
            fs.readdir(resolvedPath, (err, files) => {
                if (err) {
                    return resolve([])
                }

                const completionItems = files.map(file => {
                    const filePath = path.join(resolvedPath, file)
                    const isDirectory = fs.statSync(filePath).isDirectory()
                    const completionItem = new vscode.CompletionItem(file, isDirectory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File)
                    completionItem.insertText = isDirectory ? `${file}/` : file
                    return completionItem
                })

                resolve(completionItems)
            })
        })
    }
}
