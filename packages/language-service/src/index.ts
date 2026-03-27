import type ts from "typescript"
import { getDiagnostics } from "./features/diagnostics"
import { enhanceQuickInfo } from "./features/quickinfo"

function init(modules: { typescript: typeof ts }) {
  function create(info: ts.server.PluginCreateInfo): ts.LanguageService {
    const proxy = Object.create(null) as ts.LanguageService
    for (const k of Object.keys(info.languageService) as Array<keyof ts.LanguageService>) {
      const original = info.languageService[k]
      if (typeof original === "function") {
        ;(proxy as any)[k] = (...args: Array<unknown>) =>
          (original as Function).apply(info.languageService, args)
      }
    }

    proxy.getQuickInfoAtPosition = (fileName: string, position: number) => {
      const prior = info.languageService.getQuickInfoAtPosition(fileName, position)
      return enhanceQuickInfo(modules.typescript, info, fileName, position, prior)
    }

    proxy.getSemanticDiagnostics = (fileName: string) => {
      const prior = info.languageService.getSemanticDiagnostics(fileName)
      return getDiagnostics(modules.typescript, info, fileName, prior)
    }

    return proxy
  }

  return { create }
}

export = init
