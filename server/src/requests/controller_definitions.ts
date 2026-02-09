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
        controllerDefinitions: this.getRegisteredControllers(),
      },
      unregistered: {
        project: {
          name: "project",
          controllerDefinitions: this.getUnregisteredControllers(useAbsolutePath),
        },
        nodeModules: this.getNodeModuleControllers(useAbsolutePath),
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
    return this.service.project.registeredControllers.map((c) => c.path)
  }

  private get unregisteredControllerDefinitions() {
    return this.service.project.controllerDefinitions.filter(
      (definition) => !this.registeredControllerPaths.includes(definition.path),
    )
  }

  private get detectedNodeModules() {
    return this.service.project.detectedNodeModules
  }

  private getRegisteredControllers() {
    return this.service.project.registeredControllers.map(this.mapRegisteredController).sort(this.controllerSort)
  }

  private getUnregisteredControllers(useAbsolutePath: boolean) {
    return this.unregisteredControllerDefinitions.map((def) => this.mapControllerDefinition(def, useAbsolutePath)).sort(this.controllerSort)
  }

  private getNodeModuleControllers(useAbsolutePath: boolean) {
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
