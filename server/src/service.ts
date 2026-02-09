import path from "path"
import { Connection, InitializeParams } from "vscode-languageserver/node"
import { getLanguageService, LanguageService } from "vscode-html-languageservice"

import { StimulusHTMLDataProvider } from "./data_providers/stimulus_html_data_provider"
import { Settings } from "./settings"
import { DocumentService } from "./document_service"
import { Diagnostics } from "./diagnostics"
import { Definitions } from "./definitions"
import { Commands } from "./commands"
import { CodeActions } from "./code_actions"
import { Config } from "./config"
import { CodeLensProvider as CodeLens } from "./code_lens"

import { Project } from "stimulus-parser"

export class Service {
  connection: Connection
  settings: Settings
  htmlLanguageService: LanguageService
  stimulusDataProvider: StimulusHTMLDataProvider
  diagnostics: Diagnostics
  definitions: Definitions
  commands: Commands
  documentService: DocumentService
  codeActions: CodeActions
  project: Project
  codeLens: CodeLens
  config?: Config
  private indexFileBackups: Map<string, string> = new Map() // 원본 파일 내용 백업

  constructor(connection: Connection, params: InitializeParams) {
    this.connection = connection
    this.settings = new Settings(params, this.connection)
    this.documentService = new DocumentService(this.connection)
    this.project = new Project(this.settings.projectPath.replace("file://", ""))
    this.codeActions = new CodeActions(this.documentService, this.project, this)
    this.stimulusDataProvider = new StimulusHTMLDataProvider("id", this.project)
    this.diagnostics = new Diagnostics(this.connection, this.stimulusDataProvider, this.documentService, this.project, this)
    this.definitions = new Definitions(this.documentService, this.stimulusDataProvider)
    this.commands = new Commands(this.project, this.connection)
    this.codeLens = new CodeLens(this.documentService, this.project)

    this.htmlLanguageService = getLanguageService({
      customDataProviders: [this.stimulusDataProvider],
    })
  }

  async init() {
    // index.js 파일의 controllers/ 경로를 ./로 임시 변환하여 Project가 인식하도록 함
    await this.prepareIndexFileForParsing()

    await this.project.initialize()

    // TODO: we need to setup a file listener to check when new packages get installed
    await this.project.detectAvailablePackages()
    await this.project.analyzeAllDetectedModules()

    // Project 초기화 후 원본 파일 복원
    await this.restoreIndexFiles()

    this.config = await Config.fromPathOrNew(this.project.projectPath)

    // Only keep settings for open documents
    this.documentService.onDidClose((change) => {
      this.settings.documentSettings.delete(change.document.uri)
    })

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    this.documentService.onDidChangeContent((change) => {
      // index.js 파일이 변경된 경우 controllers/ 경로를 ./로 임시 변환하고 프로젝트 새로고침
      const filePath = change.document.uri.replace(/^file:\/\//, "")
      if (filePath.endsWith("/controllers/index.js") || filePath.endsWith("/controllers/index.ts")) {
        // 파일이 저장된 후 변환 (약간의 지연)
        setTimeout(async () => {
          await this.prepareIndexFileForParsing()
          await this.project.refresh()
          await this.restoreIndexFiles()
        }, 100)
      }
      this.diagnostics.refreshDocument(change.document)
    })
  }

  async getUseAbsolutePath(): Promise<boolean> {
    // 절대경로 감지 로직을 제거했으므로 항상 false 반환
    // index.js 파일의 controllers/ 경로는 ./로 변환되어 처리됨
    return false
  }

  async prepareIndexFileForParsing() {
    // controllers index 파일 경로 찾기
    const projectRoot = this.project.projectPath
    const possibleIndexPaths = [
      path.join(projectRoot, "app/javascript/controllers/index.js"),
      path.join(projectRoot, "app/javascript/controllers/index.ts"),
    ]

    const fs = await import("fs/promises")
    
    for (const indexPath of possibleIndexPaths) {
      try {
        const content = await fs.readFile(indexPath, "utf-8")
        
        // 원본 내용 백업 (아직 백업하지 않은 경우만)
        if (!this.indexFileBackups.has(indexPath)) {
          this.indexFileBackups.set(indexPath, content)
        }
        
        // controllers/로 시작하는 경로를 ./로 변환
        // 예: import HelloController from "controllers/hello_controller" -> import HelloController from "./hello_controller"
        // 예: import HelloController from "/controllers/hello_controller" -> import HelloController from "./hello_controller"
        let transformedContent = content.replace(
          /import\s+(?:(\w+)|(?:\{([^}]+)\}))\s+from\s+["']controllers\/([^"']+)["']/g,
          (match, defaultImport, namedImports, controllerPath) => {
            const importPart = defaultImport || (namedImports ? `{${namedImports}}` : "")
            return `import ${importPart} from "./${controllerPath}"`
          }
        )
        
        // /controllers/로 시작하는 절대경로도 변환
        transformedContent = transformedContent.replace(
          /import\s+(?:(\w+)|(?:\{([^}]+)\}))\s+from\s+["']\/controllers\/([^"']+)["']/g,
          (match, defaultImport, namedImports, controllerPath) => {
            const importPart = defaultImport || (namedImports ? `{${namedImports}}` : "")
            return `import ${importPart} from "./${controllerPath}"`
          }
        )

        // 내용이 변경된 경우에만 임시로 파일에 쓰기 (Project가 읽을 수 있도록)
        if (transformedContent !== content) {
          await fs.writeFile(indexPath, transformedContent, "utf-8")
          this.connection.console.log(
            `Temporarily transformed controllers/ imports to relative paths in ${indexPath} for parsing`
          )
        }
      } catch (error) {
        // 파일이 없거나 읽을 수 없는 경우 무시
      }
    }
  }

  async restoreIndexFiles() {
    // 원본 파일 내용 복원
    const fs = await import("fs/promises")
    
    for (const [indexPath, originalContent] of this.indexFileBackups.entries()) {
      try {
        await fs.writeFile(indexPath, originalContent, "utf-8")
        this.connection.console.log(`Restored original content to ${indexPath}`)
      } catch (error) {
        this.connection.console.log(`Error restoring ${indexPath}: ${error}`)
      }
    }
    
    this.indexFileBackups.clear()
  }

  async refresh() {
    // index.js 파일 임시 변환
    await this.prepareIndexFileForParsing()
    
    await this.project.refresh()

    // 원본 파일 복원
    await this.restoreIndexFiles()

    this.diagnostics.refreshAllDocuments()
  }

  async refreshConfig() {
    this.config = await Config.fromPathOrNew(this.project.projectPath)
  }
}
