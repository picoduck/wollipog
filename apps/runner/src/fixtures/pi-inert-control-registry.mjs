// Explicit inert event registry for the generated-source transport test. This is NOT Pi, an
// SDK substitute, or installation evidence. The separate pinned-SDK test never falls back here.
import { pathToFileURL } from "node:url";
let generation = 0;
export const createExtensionRuntime = () => ({ refreshTools() {}, invalidate() {} });
export const createEventBus = () => ({ clear() {} });
export function createBashTool(_cwd, { operations }) {
  return { name: "bash", execute: (...args) => operations.exec(...args) };
}
export async function loadExtensionFromFactory(factory, _cwd, _bus, runtime, path) {
  const extension = { path, sourceInfo: { path, source: "cli" }, handlers: new Map(), tools: new Map() };
  const api = { on(name, handler) {
    const handlers = extension.handlers.get(name) ?? []; handlers.push(handler); extension.handlers.set(name, handlers);
  }, registerTool(definition) { extension.tools.set(definition.name, { definition, sourceInfo: extension.sourceInfo }); runtime.refreshTools(); },
  getActiveTools: () => runtime.getActiveTools(), getAllTools: () => runtime.getAllTools(), setActiveTools: tools => runtime.setActiveTools(tools) };
  await factory(api); return extension;
}
export async function loadExtensions(paths, cwd, bus, runtime) {
  const extensions = [];
  for (const path of paths) {
    const factory = await import(`${pathToFileURL(path).href}?inert=${generation++}`);
    extensions.push(await loadExtensionFromFactory(factory.default, cwd, bus, runtime, path));
  }
  return { extensions, runtime, errors: [] };
}
export class ExtensionRunner {
  constructor(extensions, runtime) { this.extensions = extensions; this.runtime = runtime; }
  onError(listener) { this.error = listener; }
  setUIContext(ui) { this.ui = ui; }
  createContext() { return { hasUI: true, ui: this.ui }; }
  getAllRegisteredTools() { return this.extensions.flatMap(extension => [...extension.tools.values()]); }
  getToolDefinition(name) { return this.getAllRegisteredTools().find(tool => tool.definition.name === name)?.definition; }
  getActiveTools() { if (this.stale) throw Error("inert registry stale after reload"); return this.runtime.getActiveTools(); }
  invalidate() { this.stale = true; }
  async emit(event) {
    for (const extension of this.extensions) for (const handler of extension.handlers.get(event.type) ?? []) {
      try { await handler(event, this.createContext()); } catch (error) { this.error(error); }
    }
  }
  async emitUserBash(event) {
    for (const extension of this.extensions) for (const handler of extension.handlers.get("user_bash") ?? []) {
      try { const result = await handler(event, this.createContext()); if (result) return result; } catch (error) { this.error(error); }
    }
    return undefined;
  }
}
