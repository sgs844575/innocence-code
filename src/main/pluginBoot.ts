// Plugin boot — public face of the kernel-backed plugin host. The kernel
// itself is loaded dynamically from the staging tree (kernelLoader.ts); this
// module re-exports the pieces the composition root consumes. Electron path
// resolution (dev staging vs packaged resources) lives in harnessGlue, which
// owns the app object — this module stays Electron-free and Node-testable.
export { loadKernel, resetKernelCache, type Kernel } from "./pluginBoot/kernelLoader";
export {
  createPluginBoot,
  type PluginBoot,
  type PluginBootOptions,
} from "./pluginBoot/compose";
