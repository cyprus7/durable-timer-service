import { join } from 'node:path'
import { createApiServer } from './api/server.js'
import { readConfig } from './config.js'
import { HttpCallbackClient } from './delivery/callback-client.js'
import { StaticCallbackRegistry } from './delivery/callback-registry.js'
import { TimerWorker } from './delivery/worker.js'
import { TimerApplicationService } from './domain/timer-service.js'
import { createLogger } from './logger.js'
import { TimerMetrics } from './metrics.js'
import { PostgresTimerStore } from './storage/postgres-timer-store.js'

async function main(): Promise<void> {
  const config = readConfig()
  const logger = createLogger({ service: 'timer-service', instanceId: config.instanceId })
  const metrics = new TimerMetrics({ instanceId: config.instanceId })
  const store = new PostgresTimerStore(config.databaseUrl, logger)
  const registry = new StaticCallbackRegistry(config.targets)
  const service = new TimerApplicationService(store, registry, config, metrics)
  const callbackClient = new HttpCallbackClient(
    registry,
    config.httpClientTimeoutMs,
    config.maxCallbackResponseBytes,
    config.callbackSecret,
  )
  const worker = config.workerEnabled ? new TimerWorker(store, callbackClient, config, logger, metrics) : null
  const server = createApiServer({ config, service, store, logger, metrics })

  if (config.autoMigrate) {
    await store.runMigrationFile(join(process.cwd(), 'migrations', '001_init.sql'))
    await store.runMigrationFile(join(process.cwd(), 'migrations', '002_admission.sql'))
    logger.info('timer_service_migrations_applied')
  }

  if (config.apiToken && !config.tlsCertFile && !config.allowInsecureHttp) {
    throw new Error('Configure TLS_CERT_FILE/TLS_KEY_FILE or explicitly set ALLOW_INSECURE_HTTP=true behind a trusted TLS proxy')
  }
  if (config.allowInsecureHttp || !config.apiToken) {
    logger.warn('timer_service_insecure_transport_or_auth_enabled')
  }

  server.listen(config.port, () => {
    logger.info('timer_service_started', {
      port: config.port,
      workerEnabled: config.workerEnabled,
      lanes: config.lanes,
      targets: registry.listTargets(),
    })
  })

  worker?.start()

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info('timer_service_shutdown_started', { signal })
    const stopWorker = worker ? worker.stop() : Promise.resolve()
    const closeServer = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })

    await Promise.allSettled([stopWorker, closeServer])
    await store.close()
    logger.info('timer_service_shutdown_completed')
  }

  process.once('SIGINT', (signal) => {
    void shutdown(signal).finally(() => process.exit(0))
  })
  process.once('SIGTERM', (signal) => {
    void shutdown(signal).finally(() => process.exit(0))
  })
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', message: 'timer_service_start_failed', error }))
  process.exit(1)
})
