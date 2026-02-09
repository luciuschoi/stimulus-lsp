import { Position } from "vscode-languageserver/node"
import { RegisteredController, ControllerDefinition, ClassDeclarationNode } from "stimulus-parser"

import { Service } from "../service"

import { importStatementForController } from "../utils"

import type {
  ControllerDefinition as ControllerDefinitionRequestType,
  ControllerDefinitionsRequest as ControllerDefinitionsRequestType,
  ControllerDefinitionsResponse,
} from "../requests"

export class ControllerDefinitionsRequest {
  private service: Service

  constructor(service: Service) {
    this.service = service
  }

  async handleRequest(_request: ControllerDefinitionsRequestType): Promise<ControllerDefinitionsResponse> {
    const useAbsolutePath = await this.service.getUseAbsolutePath()
    
    return {
      registered: {
        name: "project",
        controllerDefinitions: await this.getRegisteredControllers(),
      },
      unregistered: {
        project: {
          name: "project",
          controllerDefinitions: await this.getUnregisteredControllers(useAbsolutePath),
        },
        nodeModules: await this.getNodeModuleControllers(useAbsolutePath),
      },
    }
  }

  private controllerSort(a: ControllerDefinitionRequestType, b: ControllerDefinitionRequestType) {
    return a.identifier.localeCompare(b.identifier)
  }

  private positionFromNode(node: ClassDeclarationNode | undefined) {
    return Position.create(node?.loc?.start?.line || 1, node?.loc?.start?.column || 1)
  }

  private mapControllerDefinition = (controllerDefinition: ControllerDefinition, useAbsolutePath: boolean = false) => {
    const { path, guessedIdentifier: identifier, classDeclaration } = controllerDefinition

    const registered = false
    const position = this.positionFromNode(classDeclaration.node)

    const { localName, importStatement } = importStatementForController(controllerDefinition, this.service.project, useAbsolutePath)

    return {
      path,
      identifier,
      position,
      registered,
      importStatement,
      localName,
    }
  }

  private mapRegisteredController = (registeredController: RegisteredController) => {
    const { path, identifier, classDeclaration } = registeredController

    const registered = true
    const position = this.positionFromNode(classDeclaration.node)

    return {
      path,
      identifier,
      position,
      registered,
    }
  }

  private get registeredControllerPaths() {
    const relativePathRegistered = this.service.project.registeredControllers.map((c) => c.path)
    const absolutePathRegistered = Array.from(this.service.absolutePathRegisteredControllers)
    return [...relativePathRegistered, ...absolutePathRegistered]
  }

  private get unregisteredControllerDefinitions() {
    return this.service.project.controllerDefinitions.filter(
      (definition) => !this.registeredControllerPaths.includes(definition.path),
    )
  }

  private get detectedNodeModules() {
    return this.service.project.detectedNodeModules
  }

  private async getRegisteredControllers() {
    const relativePathRegistered = this.service.project.registeredControllers.map(this.mapRegisteredController)
    
    // 절대경로로 등록된 컨트롤러도 추가
    const absolutePathRegistered = Array.from(this.service.absolutePathRegisteredControllers)
      .map((controllerPath) => {
        const controllerDefinition = this.service.project.controllerDefinitions.find(
          (def) => def.sourceFile.path === controllerPath
        )
        if (controllerDefinition) {
          return this.mapRegisteredControllerFromDefinition(controllerDefinition)
        }
        return null
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
    
    return [...relativePathRegistered, ...absolutePathRegistered].sort(this.controllerSort)
  }

  private mapRegisteredControllerFromDefinition(controllerDefinition: ControllerDefinition) {
    const { path, guessedIdentifier: identifier, classDeclaration } = controllerDefinition
    const registered = true
    const position = this.positionFromNode(classDeclaration.node)

    return {
      path,
      identifier,
      position,
      registered,
    }
  }

  private async getUnregisteredControllers(useAbsolutePath: boolean) {
    return this.unregisteredControllerDefinitions.map((def) => this.mapControllerDefinition(def, useAbsolutePath)).sort(this.controllerSort)
  }

  private async getNodeModuleControllers(useAbsolutePath: boolean) {
    // Stimulus-Use's controllers are "abstract" and meant to be extended. So we shouldn't suggest to register them.
    const excludeList = ["stimulus-use"]

    const nodeModules = this.detectedNodeModules
      .filter((module) => !excludeList.includes(module.name))
      .map((detectedModule) => {
        const { name } = detectedModule

        const controllerDefinitions = detectedModule.controllerDefinitions
          .filter((definition) => !this.registeredControllerPaths.includes(definition.path))
          .map((def) => this.mapControllerDefinition(def, useAbsolutePath))
          .sort(this.controllerSort)

        return { name, controllerDefinitions }
      })

    return nodeModules.filter((m) => m.controllerDefinitions.length > 0).sort((a, b) => a.name.localeCompare(b.name))
  }
}
