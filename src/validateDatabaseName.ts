export function validateDatabaseName(name: string): void {
    if (typeof name !== 'string') {
        throw new Error('Database name must be a string')
    }

    // Empty names are not allowed
    if (name.length === 0) {
        throw new Error('Database name cannot be empty')
    }

    // Check for null bytes which are never allowed
    if (name.includes('\0')) {
        throw new Error('Database name cannot contain null bytes')
    }

    // Check if name is already quoted
    const isQuoted = name.startsWith('"') && name.endsWith('"')

    if (isQuoted) {
        // For quoted names, ensure internal quotes are properly escaped
        const content = name.slice(1, -1)

        // Check for proper escaping of quotes
        for (let i = 0; i < content.length; i++) {
            if (content[i] === '"') {
                // A quote must be followed by another quote to be valid
                if (i + 1 < content.length && content[i + 1] === '"') {
                    i++ // Skip the next quote
                } else {
                    throw new Error('Database name contains unescaped quotes')
                }
            }
        }
    } else {
        // For unquoted names, strictly validate against PostgreSQL's unquoted identifier rules
        const validUnquotedNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/

        if (!validUnquotedNamePattern.test(name)) {
            throw new Error('Database name must either be quoted, or start with a letter or underscore and contain only letters, numbers, and underscores')
        }
    }
}
