const uWS = require('bindings')('uWS')
const WSClient = require('./ws')
const Request = require('./request')
const Response = require('./response')
const ServerError = require('./errors')
const LRU = require('lru-cache')

if (!process.nextTick) {
  process.nextTick = (f, ...args) => {
    Promise.resolve().then(() => {
      f(...args)
    })
  }
}
process.on('exit', uWS.free)

class fastWS {
  constructor({ ssl=null, verbose=false, cache=50 }={}) {
    this.options = {
      ssl,
      verbose
    }
    this._server = null
    this._socket = null
    this._port = null
    this._routes = []
    this._cache = new LRU(cache)
    process.on('SIGINT', () => this.gracefulStop())
    process.on('SIGTERM', () => this.gracefulStop())
    process.on('SIGHUP', () => this.reload())
  }

  listen(port, callback=null) {
    if (!port && !this._port) {
      throw new ServerError({ code: 'INVALID_NO_PORT', message: 'Invalid, must specify port' })
    } else if (!port) {
      port = this._port
    } else {
      this._port = port
    }
    this._server = this.options.ssl ? uWS.SSLApp(this.options.ssl) : uWS.App()
    Object.keys(this._routes).forEach(path => {
      Object.keys(this._routes[path]).forEach(method => {
        this._server[method](path, this._routes[path][method])
      })
    })
    this.gracefulStop()
    this._server.listen(port, (listenSocket) => {
      this._socket = listenSocket
      if (listenSocket) {
        this.options.verbose && console.log('Started')
        if (callback) {
          callback()
        }
      } else {
        this.options.verbose && console.log('Failed')
      }
    })
  }

  broadcast(channel, event, data, compress=true) {
    this._server.publish(channel, WSClient.getPayload({ event, data }, 'event'), false, compress)
  }

  broadcastMessage(channel, data, compress=true) {
    this._server.publish(channel, WSClient.getPayload(data), false, compress)
  }

  broadcastBinary(channel, data, compress=true) {
    this._server.publish(channel, data, true, compress)
  }

  route(method, path, callbacks) {
    if (!this._routes[path]) {
      this._routes[path] = {}
    }
    if (method === 'ws') {
      this._routes[path][method] = callbacks
    } else {
      this._routes[path][method] = async (response, request) => {
        const req = new Request(request, response)
        const res = new Response(request, response)
        try {
          await callbacks(req, res)
        } catch (e) {
          if (e instanceof ServerError && e.suggestCode) {
            if (e.originError) {
              console.error(e.originError)
            }
            res.status(e.suggestCode).end(e.message)
          } else {
            console.error(e)
            res.status(500).end('Server Internal Error')
          }
        }
      }
    }
  }

  ws(path, callback, options={}) {
    if (options.compression) {
      if (options.compression == false || options.compression === 'disable') {
        options.compression = 0
      } else if ([ 'default', 'shared' ].includes(options.compression)) {
        options.compression = 1
      } else if ([ 'dedicated' ].includes(options.compression)) {
        options.compression = 2
      } else {
        throw new ServerError({ code: 'INVALID_OPTIONS', message: 'Invalid websocket option' })
      }
    }
    if (options.idleTimeout && !Number.isInteger(options.idleTimeout)) {
      throw new ServerError({ code: 'INVALID_OPTIONS', message: 'Invalid websocket option' })
    }
    if (options.maxPayloadLength && !Number.isInteger(options.maxPayloadLength)) {
      throw new ServerError({ code: 'INVALID_OPTIONS', message: 'Invalid websocket option' })
    }
    this.route('ws', path, {
      ...options,
      open: async (ws, req) => {
        const client = new WSClient(ws, new Request(req))
        this.options.verbose && console.log('[open]', client.remoteAddress)
        ws._emitter = client
        try {
          await callback(client)
          ws.send('\x00', 0, 0)
        } catch (error) {
          console.error(error)
          // disconnect when error
          ws.close()
        }
      },
      message: (ws, message, isBinary) => {
        if (!isBinary) {
          try {
            // decode message
            ws._emitter.emitPayload(Buffer.from(message).toString())
          } catch (error) {
            if (error === 'INVALID_PAYLOAD') {
              this.options.verbose && console.log('[error]', 'Invalid message payload')
            } else {
              console.error(error)
            }
            // kick user when error
            ws.close()
          }
        } else {
          ws._emitter.emit('binary', message)
        }
      },
      drain: (ws) => {
        ws._emitter.drain()
      },
      ping: (ws) => {
        ws._emitter.emit('ping')
      },
      pong: (ws) => {
        ws._emitter.emit('pong')
      },
      close: (ws, code, message) => {
        ws._emitter.emit('disconnect')
      },
    })
  }

  get(path, callback) {
    this.route('get', path, callback)
  }

  post(path, callback) {
    this.route('post', path, callback)
  }

  patch(path, callback) {
    this.route('patch', path, callback)
  }

  del(path, callback) {
    this.route('del', path, callback)
  }

  delete(path, callback) {
    this.route('del', path, callback)
  }

  put(path, callback) {
    this.route('put', path, callback)
  }

  head(path, callback) {
    this.route('head', path, callback)
  }

  trace(path, callback) {
    this.route('trace', path, callback)
  }

  connect(path, callback) {
    this.route('connect', path, callback)
  }

  options(path, callback) {
    this.route('options', path, callback)
  }

  any(path, callback) {
    this.route('any', path, callback)
  }

  serve(path, targetPath) {
    if (targetPath) {
      this.route('get', path, (req, res) => {
        res.staticFile(targetPath, this._cache)
      })
    } else {
      this.route('get', path, (req, res) => {
        res.staticFile(req.url, this._cache)
      })
    }
  }

  gracefulStop() {
    if (this._socket) {
      this.options.verbose && console.log('Shutting down...')
      uWS.us_listen_socket_close(this._socket)
      this._socket = null
    }
  }

  reload() {
    if (this._server) {
      this.options.verbose && console.log('Reloading...')
      this.listen()
    }
  }
}

module.exports = fastWS