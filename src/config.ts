import * as vscode from 'vscode'
import { showMessage } from './showMessage'

export const EXTENSION_NAME: string = 'pglint'
export const LINT_COMMAND: string = 'pglint.lint'
export const TERMINATE_COMMAND: string = 'pglint.terminateTemplateConnections'

export interface PgLintConfig {
    databaseUrl: string
    languageIds: string[]
    lintOnSave: boolean
    clearOnChange: boolean
    queryStats: boolean
    autoTerminateTemplateConnections: boolean
    tempDatabasePrefix: string
    usePlPgsqlCheck: boolean
}

export class ConfigKey {
    public static readonly languageIds: string = 'languageIds'
    public static readonly databaseUrl: string = 'databaseUrl'
    public static readonly lintOnSave: string = 'lintOnSave'
    public static readonly clearOnChange: string = 'clearOnChange'
    public static readonly queryStats: string = 'queryStats'
    public static readonly autoTerminateTemplateConnections: string = 'autoTerminateTemplateConnections'
    public static readonly tempDatabasePrefix: string = 'tempDatabasePrefix'
    public static readonly usePlPgsqlCheck: string = 'usePlPgsqlCheck'
}

export class ConfigurationManager {

    private config: vscode.WorkspaceConfiguration
    private subscription: vscode.Disposable
    private defaultConfig: Partial<PgLintConfig> = {
        languageIds: ['sql', 'postgres'],
        lintOnSave: true,
        clearOnChange: true,
        queryStats: true,
        autoTerminateTemplateConnections: false,
        tempDatabasePrefix: 'temp_pglint_',
        usePlPgsqlCheck: true,
    }

    public getSubscription(): vscode.Disposable {
        return this.subscription
    }

    constructor() {
        this.config = vscode.workspace.getConfiguration(EXTENSION_NAME)
        this.subscription = this.setupConfigurationListener()
    }

    private setupConfigurationListener(): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(EXTENSION_NAME)) {
                this.config = vscode.workspace.getConfiguration(EXTENSION_NAME)
                this.validate()
            }
        })
    }

    private getMaybe(): Partial<PgLintConfig> {
        return {
            databaseUrl: this.config.get(ConfigKey.databaseUrl),
            languageIds: this.config.get(ConfigKey.languageIds, this.defaultConfig.languageIds!),
            lintOnSave: this.config.get(ConfigKey.lintOnSave, this.defaultConfig.lintOnSave!),
            clearOnChange: this.config.get(ConfigKey.clearOnChange, this.defaultConfig.clearOnChange!),
            queryStats: this.config.get(ConfigKey.queryStats, this.defaultConfig.queryStats!),
            autoTerminateTemplateConnections: this.config.get(ConfigKey.autoTerminateTemplateConnections, this.defaultConfig.autoTerminateTemplateConnections!),
            tempDatabasePrefix: this.config.get(ConfigKey.tempDatabasePrefix, this.defaultConfig.tempDatabasePrefix!),
            usePlPgsqlCheck: this.config.get(ConfigKey.usePlPgsqlCheck, this.defaultConfig.usePlPgsqlCheck!)
        }
    }

    private databaseUrlError(): string {
        return `Please set ${EXTENSION_NAME}.databaseUrl in settings.`
    }

    public get(): PgLintConfig {
        const config = this.getMaybe()
        const { databaseUrl } = config
        if (!databaseUrl) {
            throw new Error(this.databaseUrlError())
        }
        return config as Required<PgLintConfig>
    }

    private validate(): void {
        const config = this.getMaybe()
        if (!config.databaseUrl) {
            showMessage(vscode.LogLevel.Error, this.databaseUrlError())
        }
    }
}

let _configManager!: ConfigurationManager
let _channel!: vscode.OutputChannel

export function getConfigManager(): ConfigurationManager {
    return _configManager
}

export function getChannel(): vscode.OutputChannel {
    return _channel
}

export function setup() {
    _channel = vscode.window.createOutputChannel(EXTENSION_NAME)
    _configManager = new ConfigurationManager()
}

export function teardown() {
    _channel.dispose()
}
