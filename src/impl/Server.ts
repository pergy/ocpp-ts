import EventEmitter from 'events';
import WebSocket, { WebSocketServer } from 'ws';
import { SecureContextOptions } from 'tls';
import { createServer as createHttpsServer } from 'https';
import { createServer as createHttpServer, IncomingMessage } from 'http';
import stream from 'node:stream';
import { OCPP_PROTOCOL_1_6 } from './schemas';
import { Client } from './Client';
import { OcppClientConnection } from '../OcppClientConnection';
import { Protocol } from './Protocol';

export class Server extends EventEmitter {
  server: WebSocket.Server | null = null;
  clients: Array<Client> = [];
  port: number | null = null;

  protected listen(port = 9220, options?: SecureContextOptions) {
    let server;
    if (options) {
      server = createHttpsServer(options || {});
    } else {
      server = createHttpServer();
    }

    this.port = port
    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string>) => {
        console.log('[wss] handle protocol requested', protocols)
        if (protocols.has(OCPP_PROTOCOL_1_6)) {
          return OCPP_PROTOCOL_1_6;
        }
        console.log('[wss] no valid protocol')
        return false;
      },
    });

    wss.on('connection', (ws, req) => this.onNewConnection(ws, req));

    server.on('upgrade', (req: IncomingMessage, socket: stream.Duplex, head: Buffer) => {
      console.log('[HTTP] upgrade requested', req.url)
      const cpId = Server.getCpIdFromUrl(req.url);
      console.log('[HTTP] extracted id', cpId)
      if (!cpId) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
      } else if (this.listenerCount('authorization')) {
        console.log('[Server] authorization callback')
        this.emit('authorization', cpId, req, (err?: Error) => {
          if (err) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
          } else {
            console.log('[Server] authorization OK')
            console.log('[wss] handle upgrade')
            wss.handleUpgrade(req, socket, head, (ws) => {
              console.log('[Server] connection callback')
              wss.emit('connection', ws, req);
            });
          }
        });
      } else {
        console.log('[wss] handle upgrade')
        wss.handleUpgrade(req, socket, head, (ws) => {
          console.log('[Server] connection callback')
          wss.emit('connection', ws, req);
        });
      }
    });

    server.listen(port);
  }

  private onNewConnection(socket: WebSocket, req: IncomingMessage) {
    console.log('[wss] new connection', socket, req.url)
    const cpId = Server.getCpIdFromUrl(req.url);
    console.log('[wss] extracted id', cpId)
    if (!socket.protocol || !cpId) {
      // From Spec: If the Central System does not agree to using one of the subprotocols offered
      // by the client, it MUST complete the WebSocket handshake with a response without a
      // Sec-WebSocket-Protocol header and then immediately close the WebSocket connection.
      console.info('Closed connection due to unsupported protocol');
      socket.close();
      return;
    }

    const client = new OcppClientConnection(cpId);
    client.setConnection(new Protocol(client, socket));

    socket.on('error', (err) => {
      console.info(err.message, socket.readyState);
      client.emit('error', err);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      const index = this.clients.indexOf(client);
      this.clients.splice(index, 1);
      client.emit('close', code, reason);
      // this.emit('close', client, code, reason);
    });
    this.clients.push(client);
    this.emit('connection', client);
  }

  static getCpIdFromUrl(url: string | undefined): string | undefined {
    try {
      if (url) {
        const encodedCpId = url.split('/')
        .pop();
        if (encodedCpId) {
          return decodeURI(encodedCpId.split('?')[0]);
        }
      }
    } catch (e) {
      console.error(e);
    }
    return undefined;
  }
}
