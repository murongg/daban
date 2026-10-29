import net from 'node:net';

export async function availablePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    // A bind probe must never send requests or credentials to an existing listener.
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (preferred && error.code === 'EADDRINUSE') availablePort().then(resolve, reject);
      else reject(error);
    });
    server.listen(preferred, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (address && typeof address !== 'string') resolve(address.port);
        else reject(new Error('SETUP_CONNECT'));
      });
    });
  });
}
