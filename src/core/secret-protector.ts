export interface SecretProtector {
  isAvailable(): Promise<boolean>
  encryptString(value: string): Promise<Buffer>
  decryptString(value: Buffer): Promise<string>
}