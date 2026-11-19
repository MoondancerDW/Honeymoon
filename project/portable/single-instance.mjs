import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {createConnection, createServer} from 'node:net';
import {once} from 'node:events';

const readyTimeout = 30000;

export async function acquireInstance(project) {
  const path = await realpath(project);
  const canonical = process.platform === 'win32' ? path.toLowerCase() : path;
  const projectKey = createHash('sha256').update(canonical).digest('hex').slice(0,32);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\honeymoon-${projectKey}` : `\0honeymoon-${projectKey}`;
  const waiting = new Set();
  let published;
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.setTimeout(readyTimeout, () => socket.destroy());
    socket.on('close', () => waiting.delete(socket));
    if (published) socket.end(published);
    else waiting.add(socket);
  });
  server.maxConnections = 32;
  try {
    server.listen({path:address, exclusive:true});
    await once(server,'listening');
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const info = await new Promise((resolve,reject) => {
      const socket = createConnection(address);
      let data = '';
      const fail = error => { socket.destroy(); reject(error); };
      socket.setTimeout(readyTimeout, () => fail(new Error('The running Lilium Moonlight instance did not become ready in 30 seconds.')));
      socket.on('error',fail);
      socket.on('data',chunk => {
        data += chunk;
        if (data.length > 2048) fail(new Error('Invalid Lilium Moonlight instance response.'));
      });
      socket.on('end',() => {
        try {
          const info = JSON.parse(data);
          if (info.projectKey !== projectKey || !['local','lan','tailscale','internet','single-player'].includes(info.mode) ||
              !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(info.url)) throw new Error('Invalid Lilium Moonlight instance response.');
          resolve(info);
        } catch (error) { fail(error); }
      });
    });
    return {primary:false,info};
  }
  let closing;
  return {
    primary:true,
    publish(info) {
      published = JSON.stringify({...info,projectKey}) + '\n';
      for (const socket of waiting) socket.end(published);
      waiting.clear();
    },
    close() {
      return closing ??= new Promise((resolve,reject) => {
        for (const socket of waiting) socket.destroy();
        waiting.clear();
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}
