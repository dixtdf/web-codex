import { describe, expect, it } from 'vitest'
import { AppError, assertCondition, errorMessage } from '../../src/core/errors'

describe('core errors', () => {
  it('preserves application error metadata and formats unknown values', () => {
    const error = new AppError('Invalid input', 'INVALID_INPUT', { field: 'path' })

    expect(error).toMatchObject({ name: 'AppError', message: 'Invalid input', code: 'INVALID_INPUT', details: { field: 'path' } })
    expect(errorMessage(error)).toBe('Invalid input')
    expect(errorMessage('plain failure')).toBe('plain failure')
    expect(errorMessage(42)).toBe('42')
  })

  it('asserts conditions with stable error codes and accepts valid input', () => {
    expect(() => assertCondition(true, 'unused', 'UNUSED')).not.toThrow()
    expect(() => assertCondition(false, 'Invalid state', 'INVALID_STATE')).toThrowError(expect.objectContaining({
      name: 'AppError',
      message: 'Invalid state',
      code: 'INVALID_STATE'
    }))
  })
})