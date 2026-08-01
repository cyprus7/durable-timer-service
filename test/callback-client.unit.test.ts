import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { HttpCallbackClient } from '../src/delivery/callback-client.js'
import { StaticCallbackRegistry } from '../src/delivery/callback-registry.js'
import type { ClaimedTimer } from '../src/domain/types.js'

test('callback client stops reading responses above the configured limit', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ disposition: 'applied', padding: 'x'.repeat(2048) }))
  })

  await listen(server)

  try {
    const address = server.address()

    if (!address || typeof address === 'string') {
      throw new Error('Failed to start callback test server')
    }

    const registry = new StaticCallbackRegistry(
      new Map([['example-worker', `http://127.0.0.1:${address.port}/callback`]]),
    )
    const client = new HttpCallbackClient(registry, 1_000, 128)
    const now = new Date()
    const result = await client.deliver({
      namespace: 'example',
      timerKey: 'workflow:8d12:retry',
      timerId: 'timer-response-limit',
      generation: 1,
      sessionId: 'workflow:8d12',
      kind: 'job.retry',
      lane: 'realtime',
      dueAt: now,
      deliverUntil: new Date(now.getTime() + 60_000),
      target: 'example-worker',
      routingKey: null,
      payload: {},
      attempt: 0,
      leaseOwner: 'test',
      leaseUntil: new Date(now.getTime() + 1_000),
      scheduledAt: now,
      updatedAt: now,
    } satisfies ClaimedTimer)

    assert.equal(result.kind, 'retry')
    assert.equal(result.reason, 'response_too_large')
  } finally {
    await closeServer(server)
  }
})

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
