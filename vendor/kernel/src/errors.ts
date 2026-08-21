/** Default messages behind each kernel error code. */
export const KernelErrorMessages = {
  INACTIVE_EFFECT: "cannot register an effect on a fiber that is disposed or unloading",
  SERVICE_NAME_CONFLICT:
    "cannot publish a service under a name that already exists on the context",
  DUPLICATE_SERVICE: "cannot publish a service that is already published; withdraw it first",
} as const;

/** Stable machine-readable codes carried by {@link KernelError}. */
export type KernelErrorCode = keyof typeof KernelErrorMessages;

/**
 * Kernel error with a stable, machine-readable `code`.
 *
 * Callers match on `code` rather than on message text or subclasses, so
 * new failure causes can be added without breaking consumers.
 */
export class KernelError extends Error {
  constructor(readonly code: KernelErrorCode, message?: string) {
    super(message ?? KernelErrorMessages[code]);
  }
}
