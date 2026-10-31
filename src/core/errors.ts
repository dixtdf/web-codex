export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function assertCondition(condition: unknown, message: string, code: string): asserts condition {
  if (!condition) {
    throw new AppError(message, code)
  }
}