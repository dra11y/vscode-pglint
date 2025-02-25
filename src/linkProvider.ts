import * as vscode from 'vscode'
import * as path from 'path'

export class IncludeLinkProvider implements vscode.DocumentLinkProvider {
    async provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentLink[]> {
        const links: vscode.DocumentLink[] = []
        const text = document.getText()
        const includeRegex = /^--\s*@include[:\s]\s*(.*)$/gm
        let match: RegExpExecArray | null

        while ((match = includeRegex.exec(text)) !== null) {
            const includePath = match[1].trim()
            const offset = match.index + match[0].indexOf(includePath)
            const start = document.positionAt(offset)
            const end = document.positionAt(offset + includePath.length)
            const range = new vscode.Range(start, end)

            const dirPath = path.dirname(document.uri.fsPath)
            const resolvedPath = path.resolve(dirPath, includePath)
            const targetUri = vscode.Uri.file(resolvedPath)

            let link = new vscode.DocumentLink(range, targetUri)
            link.tooltip = resolvedPath
            links.push(link)
        }

        return links
    }
}
