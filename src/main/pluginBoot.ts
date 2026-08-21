// Plugin boot — public face of the kernel-backed plugin host. The kernel and
// the registration spine are loaded dynamically from the staging tree
// (kernelLoader.ts / spineLoader.ts — one kernel + one spine per process);
// this module re-exports the pieces the composition root consumes. Electron
// path resolution (dev staging vs packaged resources) lives in harnessGlue,
// which owns the app object — this module stays Electron-free and
// Node-testable.
export { loadKernel, resetKernelCache, type Kernel } from "./pluginBoot/kernelLoader";
export {
  loadKernelSuite,
  resetSuiteCache,
  type KernelSuite,
  type LoaderModule,
} from "./pluginBoot/spineLoader";
export {
  createPluginBoot,
  type PluginBoot,
  type PluginBootOptions,
} from "./pluginBoot/compose";
export {
  createSessionComposition,
  type SessionComposition,
  type SessionCompositionOptions,
} from "./pluginBoot/sessionComposition";
