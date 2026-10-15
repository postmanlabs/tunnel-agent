'use strict'

var assert = require('node:assert')
  , http = require('node:http')
  , net = require('node:net')
  , events = require('node:events')
  , test = require('node:test')
  , tunnel = require('../index')
  ;

var MESSAGE = 'TunnelingAgent.createConnection requires an object with a "request" property'

// Starts a proxy that records CONNECT targets and answers with `statusCode`.
// On 200, `onTunnel(req, socket)` takes over the socket.
async function startProxy(t, statusCode, onTunnel) {
  var connects = []
  var proxy = http.createServer()
  proxy.on('connect', function(req, socket) {
    connects.push(req.url)
    socket.on('error', function() {})
    if (statusCode !== 200) {
      socket.end('HTTP/1.1 ' + statusCode + ' Nope\r\nConnection: close\r\n\r\n')
      return
    }
    onTunnel(req, socket)
  })
  await events.once(proxy.listen(0, '127.0.0.1'), 'listening')
  t.after(function() {
    proxy.close()
    proxy.closeAllConnections()
  })
  return {server: proxy, connects: connects, port: proxy.address().port}
}

function fakeRequest() {
  var req = new events.EventEmitter()
  req.sockets = []
  req.onSocket = function(socket) {
    req.sockets.push(socket)
    req.emit('socket', socket)
  }
  return req
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms) })
}

;['httpOverHttp', 'httpsOverHttp'].forEach(function(factory) {
  test.describe(factory, function() {
    test('createConnection without a request throws synchronously', async function(t) {
      var proxy = await startProxy(t, 200, function() {})
      var agent = tunnel[factory]({proxy: {host: '127.0.0.1', port: proxy.port}})

      ;[undefined, null, {host: 'example.com', port: 80}, {request: null}].forEach(function(pending) {
        assert.throws(function() { agent.createConnection(pending) }, function(err) {
          return err instanceof TypeError && err.message === MESSAGE
        })
      })
      assert.strictEqual(agent.sockets.length, 0)

      await sleep(50)
      assert.deepStrictEqual(proxy.connects, [])
    })

    test('createSocket without a request throws synchronously', async function(t) {
      var proxy = await startProxy(t, 200, function() {})
      var agent = tunnel[factory]({proxy: {host: '127.0.0.1', port: proxy.port}})

      assert.throws(function() {
        agent.createSocket({host: 'example.com', port: 80}, function() {})
      }, /requires an object with a "request" property/)
      assert.strictEqual(agent.sockets.length, 0)

      await sleep(50)
      assert.deepStrictEqual(proxy.connects, [])
    })

    test('non-200 proxy reply emits error on the request', async function(t) {
      var proxy = await startProxy(t, 407)
      var agent = tunnel[factory]({proxy: {host: '127.0.0.1', port: proxy.port}})
      var req = fakeRequest()

      agent.addRequest(req, {host: 'example.com', port: 80})
      var err = (await events.once(req, 'error'))[0]

      assert.strictEqual(err.code, 'ECONNRESET')
      assert.strictEqual(err.res.statusCode, 407)
      assert.deepStrictEqual(proxy.connects, ['example.com:80'])
    })

    test('unreachable proxy emits error on the request', async function(t) {
      var proxy = await startProxy(t, 200, function() {})
      var port = proxy.port
      proxy.server.close()
      var agent = tunnel[factory]({proxy: {host: '127.0.0.1', port: port}})
      var req = fakeRequest()

      agent.addRequest(req, {host: 'example.com', port: 80})
      var err = (await events.once(req, 'error'))[0]

      assert.strictEqual(err.code, 'ECONNRESET')
    })
  })
})

test('httpOverHttp tunnels a request through the proxy', async function(t) {
  var agent
  var target = http.createServer(function(req, res) { res.end('hello') })
  await events.once(target.listen(0, '127.0.0.1'), 'listening')
  t.after(function() {
    agent.sockets.forEach(function(socket) { socket.destroy() })
    target.close()
    target.closeAllConnections()
  })
  var targetPort = target.address().port

  var proxy = await startProxy(t, 200, function(req, clientSocket) {
    var upstream = net.connect(targetPort, '127.0.0.1', function() {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', function() {})
  })
  agent = tunnel.httpOverHttp({proxy: {host: '127.0.0.1', port: proxy.port}})

  var res = (await events.once(
    http.get({host: '127.0.0.1', port: targetPort, agent: agent}), 'response'))[0]
  var body = ''
  for await (var chunk of res) body += chunk


  assert.strictEqual(body, 'hello')
  assert.deepStrictEqual(proxy.connects, ['127.0.0.1:' + targetPort])
})

test('httpsOverHttp hands the established tunnel to the request over TLS', async function(t) {
  var proxy = await startProxy(t, 200, function(req, socket) {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  })
  var agent = tunnel.httpsOverHttp({proxy: {host: '127.0.0.1', port: proxy.port}})
  var req = fakeRequest()

  agent.addRequest(req, {host: 'example.com', port: 443})
  var socket = (await events.once(req, 'socket'))[0]
  socket.on('error', function() {})
  t.after(function() { socket.destroy() })

  assert.strictEqual(typeof socket.getProtocol, 'function')
  assert.deepStrictEqual(proxy.connects, ['example.com:443'])
})
