import type { AppConfig, RuntimeSnapshot } from '../../shared/types'
import type { Notify } from '../App'

export interface PageProps {
  config: AppConfig
  runtime: RuntimeSnapshot
  notify: Notify
  refresh: () => Promise<void>
}