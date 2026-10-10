/**
 * ADR-0187 B5-M — the modelscan settings as data: the source of truth the committed
 * `engines/modelscan/modelscan-settings.toml` is checked against (settings.test.ts parses the TOML
 * and compares). The image bakes that file read-only and the scanner always passes it with
 * `--settings-file` from an empty working directory, so modelscan never picks up a settings file
 * (which names the classes it imports) from anywhere else.
 */
import type { ModelscanScanExtension } from "@regulait/shared";

/** where the image puts things (engines/modelscan/Dockerfile) */
export const MODELSCAN_IMAGE_PATHS = {
  modelscanBin: "/opt/modelscan/venv/bin/modelscan",
  settingsFile: "/opt/modelscan/modelscan-settings.toml",
  venvBin: "/opt/modelscan/venv/bin",
} as const;

const PICKLE_EXT = [".pkl", ".pickle", ".joblib", ".dill", ".dat", ".data"];
const PYTORCH_EXT = [".bin", ".pt", ".pth", ".ckpt"];

export const MODELSCAN_SETTINGS = {
  modelscan_version: "0.8.8",
  supported_zip_extensions: [".zip", ".npz"],
  scanners: {
    "modelscan.scanners.H5LambdaDetectScan": { enabled: true, supported_extensions: [".h5"] },
    "modelscan.scanners.KerasLambdaDetectScan": { enabled: true, supported_extensions: [".keras"] },
    "modelscan.scanners.SavedModelLambdaDetectScan": { enabled: true, supported_extensions: [".pb"], unsafe_keras_operators: { Lambda: "MEDIUM" } },
    "modelscan.scanners.SavedModelTensorflowOpScan": { enabled: true, supported_extensions: [".pb"], unsafe_tf_operators: { ReadFile: "HIGH", WriteFile: "HIGH" } },
    "modelscan.scanners.NumpyUnsafeOpScan": { enabled: true, supported_extensions: [".npy"] },
    "modelscan.scanners.PickleUnsafeOpScan": { enabled: true, supported_extensions: PICKLE_EXT },
    "modelscan.scanners.PyTorchUnsafeOpScan": { enabled: true, supported_extensions: PYTORCH_EXT },
  },
  middlewares: {
    "modelscan.middlewares.FormatViaExtensionMiddleware": {
      formats: { tensorflow: [".pb"], keras_h5: [".h5"], keras: [".keras"], numpy: [".npy"], pytorch: PYTORCH_EXT, pickle: PICKLE_EXT },
    },
  },
  unsafe_globals: {
    CRITICAL: {
      __builtin__: ["eval", "compile", "getattr", "setattr", "delattr", "apply", "exec", "execfile", "open", "breakpoint", "__import__", "globals", "locals", "vars", "input"],
      builtins: ["eval", "compile", "getattr", "setattr", "delattr", "apply", "exec", "open", "breakpoint", "__import__", "globals", "locals", "vars", "input"],
      runpy: "*",
      os: "*",
      nt: "*",
      posix: "*",
      socket: "*",
      subprocess: "*",
      sys: "*",
      operator: ["attrgetter", "methodcaller"],
      pty: "*",
      pickle: "*",
      _pickle: "*",
      bdb: "*",
      pdb: "*",
      shutil: "*",
      asyncio: "*",
      importlib: "*",
      "importlib.util": "*",
      "importlib.machinery": "*",
      ctypes: "*",
      "ctypes.util": "*",
      code: "*",
      codeop: "*",
      marshal: "*",
      types: "*",
      multiprocessing: "*",
      _posixsubprocess: "*",
      cffi: "*",
      "torch.hub": "*",
      "torch.utils.cpp_extension": "*",
    },
    HIGH: {
      webbrowser: "*",
      httplib: "*",
      "http.client": "*",
      "urllib.request": "*",
      urllib: "*",
      ftplib: "*",
      smtplib: "*",
      telnetlib: "*",
      "requests.api": "*",
      requests: "*",
      "aiohttp.client": "*",
      aiohttp: "*",
      io: ["open", "open_code", "FileIO"],
      _io: ["open", "open_code", "FileIO"],
      tempfile: "*",
      pathlib: "*",
      glob: "*",
      zipimport: "*",
      dill: "*",
    },
    MEDIUM: { functools: ["partial", "reduce"], "numpy.testing._private.utils": "*" },
    LOW: {},
  },
  reporting: { module: "modelscan.reports.JSONReport", settings: {} },
} as const;

/** the deny-list additions over modelscan's defaults that G19 measured slipping through (each red-proven) */
export const MODELSCAN_DENYLIST_ADDITIONS = ["importlib", "ctypes", "http.client", "code", "marshal", "types", "operator.methodcaller"] as const;

/** every extension our format plans hand modelscan must be one its settings scan */
export function settingsScanExtension(ext: ModelscanScanExtension): boolean {
  if ((MODELSCAN_SETTINGS.supported_zip_extensions as readonly string[]).includes(ext)) return true;
  return Object.values(MODELSCAN_SETTINGS.scanners).some((s) => (s.supported_extensions as readonly string[]).includes(ext));
}
