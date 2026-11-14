import {createSecureServer} from 'node:http2';
import {request} from 'node:http';
import {readFileSync} from 'node:fs';

const [backend, port, key, cert] = process.argv.slice(2);
const server = createSecureServer({key:readFileSync(key), cert:readFileSync(cert), allowHTTP1:true}, (incoming, outgoing) => {
  const forwarded = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !name.startsWith(':')));
  forwarded.host = incoming.headers[':authority'] ?? forwarded.host;
  forwarded['x-forwarded-proto'] = 'https';
  const origin = request({hostname:'127.0.0.1', port:backend, path:incoming.url,
    method:incoming.method, headers:forwarded}, response => {
    const headers = Object.fromEntries(Object.entries(response.headers)
      .filter(([name]) => !['connection','keep-alive','transfer-encoding'].includes(name)));
    outgoing.writeHead(response.statusCode, headers);
    response.pipe(outgoing);
  });
  incoming.pipe(origin);
  outgoing.on('close', () => origin.destroy());
  origin.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
});
server.listen(Number(port), '127.0.0.1', () => console.log(`https://localhost:${port}`));
