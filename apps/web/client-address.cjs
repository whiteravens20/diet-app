// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.
'use strict';

/**
 * Loaded before the web server (`node --require client-address.cjs server.js`): every request the
 * server accepts carries in X-Client-Address the address of the connection it came on, over
 * whatever a client wrote there, and the server hands it on to the API with the rest of the
 * request. The API believes the header from this server alone, by its address on the Compose
 * network (`apps/api/src/rate-limit/web-server.ts`), and so tells its clients apart where no
 * reverse proxy says who they are.
 */
const http = require('node:http');

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function emitWithClientAddress(event, req, ...rest) {
  if (event === 'request' && req && req.headers && req.socket) {
    req.headers['x-client-address'] = req.socket.remoteAddress ?? '';
  }
  return emit.call(this, event, req, ...rest);
};
