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

test('callbacks carry the optional secret but never follow any redirect', async () => {
  let leakedRequests = 0
  let seenSecret: string | undefined
  let status = 200
  const destination = createServer((_req, res) => { leakedRequests++; res.end('{"disposition":"applied"}') })
  await listen(destination)
  const destinationAddress = destination.address() as { port: number }
  const source = createServer((req, res) => {
    seenSecret = req.headers['x-timer-callback-secret'] as string | undefined
    req.resume()
    res.statusCode = status
    res.setHeader('location', `http://127.0.0.1:${destinationAddress.port}/private`)
    res.end('{"disposition":"applied"}')
  })
  await listen(source)
  try {
    const address = source.address() as { port: number }
    const registry = new StaticCallbackRegistry(new Map([['worker', `http://127.0.0.1:${address.port}`]]))
    const client = new HttpCallbackClient(registry, 1000, 65536, 'test-callback-secret')
    const now = new Date()
    const timer: ClaimedTimer = {
      namespace: 'test', timerKey: 'key', timerId: 'id', generation: 1, sessionId: 'session', kind: 'test',
      lane: 'realtime', dueAt: now, deliverUntil: now, target: 'worker', routingKey: null,
      payload: { private: 'payload' }, attempt: 0, leaseOwner: 'test', leaseUntil: now, scheduledAt: now, updatedAt: now,
    }
    assert.equal((await client.deliver(timer)).kind, 'terminal')
    assert.equal(seenSecret, 'test-callback-secret')
    for (status of [301, 302, 303, 307, 308]) {
      assert.equal((await client.deliver(timer)).kind, 'retry')
    }
    assert.equal(leakedRequests, 0)
    status = 200
    await new HttpCallbackClient(registry, 1000).deliver(timer)
    assert.equal(seenSecret, undefined)
  } finally { await Promise.all([closeServer(source), closeServer(destination)]) }
})

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
