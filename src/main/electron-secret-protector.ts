import { safeStorage } from 'electron/main'
import type { SecretProtector } from '../core/secret-protector'

export class ElectronSecretProtector implements SecretProtector {
  async isAvailable(): Promise<boolean> {
    return await safeStorage.isAsyncEncryptionAvailable()
  }

  async encryptString(value: string): Promise<Buffer> {
    return await safeStorage.encryptStringAsync(value)
  }

  async decryptString(value: Buffer): Promise<string> {
    const decrypted = await safeStorage.decryptStringAsync(value)
    return decrypted.result
  }
}