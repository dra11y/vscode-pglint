export interface Statement {
    sql: string
    start: number
    end: number
}

export function splitSqlWithPositions(sql: string): Statement[] {
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
            sql: currentText,
            start: currentStart,
            end: pos - 1
        })
    }

    return statements
}
