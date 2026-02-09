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
  absolutePathRegisteredControllers: Set<string> = new Set() // 절대경로로 등록된 컨트롤러 경로 추적

  constructor(connection: Connection, params: InitializeParams) {
    this.connection = connection
    this.settings = new Settings(params, this.connection)
    this.documentService = new DocumentService(this.connection)
    this.project = new Project(this.settings.projectPath.replace("file://", ""))
    this.codeActions = new CodeActions(this.documentService, this.project, this)
    this.stimulusDataProvider = new StimulusHTMLDataProvider("id", this.project)
    this.diagnostics = new Diagnostics(this.connection, this.stimulusDataProvider, this.documentService, this.project, this)
    this.definitions = new Definitions(this.documentService, this.stimulusDataProvider)
    this.commands = new Commands(this.project, this.connection, this)
    this.codeLens = new CodeLens(this.documentService, this.project)

    this.htmlLanguageService = getLanguageService({
      customDataProviders: [this.stimulusDataProvider],
    })
  }

  async init() {
    await this.project.initialize()

    // TODO: we need to setup a file listener to check when new packages get installed
    await this.project.detectAvailablePackages()
    await this.project.analyzeAllDetectedModules()

    this.config = await Config.fromPathOrNew(this.project.projectPath)

    // 절대경로 import를 파싱하여 컨트롤러 등록 감지
    await this.detectAbsolutePathControllers()

    // Only keep settings for open documents
    this.documentService.onDidClose((change) => {
      this.settings.documentSettings.delete(change.document.uri)
    })

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    this.documentService.onDidChangeContent((change) => {
      this.diagnostics.refreshDocument(change.document)
    })
  }

  async getUseAbsolutePath(): Promise<boolean> {
    // 설정에서 절대경로 사용 여부 확인
    try {
      const projectUri = `file://${this.project.projectPath}`
      const settings = await this.settings.getDocumentSettings(projectUri)
      return settings.useAbsolutePaths || false
    } catch {
      return false
    }
  }

  async detectAbsolutePathControllers() {
    // index.js 파일에서 절대경로 import를 파싱하여 컨트롤러 등록 감지
    if (this.project.controllersIndexFiles.length === 0) return

    const indexFilePath = this.project.controllersIndexFiles[0].path
    const fs = await import("fs/promises")
    
    try {
      const content = await fs.readFile(indexFilePath, "utf-8")
      await this.parseAbsolutePathImports(content, indexFilePath)
    } catch (error) {
      // 파일을 읽을 수 없는 경우 무시
    }
  }

  async parseAbsolutePathImports(content: string, indexFilePath: string) {
    // 절대경로 import 패턴 찾기: import ... from "/controllers/..."
    const absoluteImportRegex = /import\s+(?:(\w+)|(?:\{([^}]+)\}))\s+from\s+["'](\/[^"']+)["']/g
    
    const matches = Array.from(content.matchAll(absoluteImportRegex))
    
    for (const match of matches) {
      const defaultImport = match[1]
      const namedImports = match[2]
      const importPath = match[3]
      
      // 절대경로에서 컨트롤러 파일 경로 찾기
      const controllerPath = this.resolveAbsolutePathToController(importPath)
      if (!controllerPath) continue
      
      // 절대경로로 등록된 컨트롤러로 표시
      this.absolutePathRegisteredControllers.add(controllerPath)
      
      this.connection.console.log(
        `Detected absolute path controller: ${controllerPath} from ${importPath}`
      )
    }
  }

  resolveAbsolutePathToController(absolutePath: string): string | null {
    // 절대경로를 실제 파일 경로로 변환
    // 예: /controllers/hello_controller -> app/javascript/controllers/hello_controller.js
    const projectRoot = this.project.projectPath
    
    // 절대경로에서 / 제거하고 프로젝트 루트와 결합
    const relativePath = absolutePath.startsWith("/") ? absolutePath.slice(1) : absolutePath
    
    // 가능한 확장자들 시도
    const extensions = [".js", ".ts", ".jsx", ".tsx"]
    
    for (const ext of extensions) {
      const fullPath = path.join(projectRoot, relativePath + ext)
      if (this.fileExistsSync(fullPath)) {
        return fullPath
      }
    }
    
    // 확장자 없이도 시도
    const fullPathWithoutExt = path.join(projectRoot, relativePath)
    if (this.fileExistsSync(fullPathWithoutExt)) {
      return fullPathWithoutExt
    }
    
    return null
  }

  fileExistsSync(filePath: string): boolean {
    try {
      const fs = require("fs")
      return fs.existsSync(filePath)
    } catch {
      return false
    }
  }

  async refresh() {
    await this.project.refresh()

    this.diagnostics.refreshAllDocuments()
  }

  async refreshConfig() {
    this.config = await Config.fromPathOrNew(this.project.projectPath)
  }
}
