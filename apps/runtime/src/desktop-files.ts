import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

// This helper runs inside the desktop namespace. Service-UID filesystem calls on desktop paths could follow planted links into private data.
const limit = 2 * 1024 * 1024;
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > limit) throw new Error('DESKTOP_IO_LIMIT');
  }
  const request = JSON.parse(input) as {
    root?: unknown;
    file?: unknown;
    op?: unknown;
    text?: unknown;
    mode?: unknown;
    exclusive?: unknown;
  };
  if (
    typeof request.root !== 'string' ||
    typeof request.file !== 'string' ||
    !path.isAbsolute(request.root) ||
    !path.isAbsolute(request.file)
  )
    throw new Error('DESKTOP_IO_INVALID');
  const relative = path.relative(request.root, request.file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('DESKTOP_IO_INVALID');
  const mode = request.mode === 0o700 ? 0o700 : 0o600;
  if (request.op === 'mkdir') await mkdir(request.file, { recursive: true, mode: 0o700 });
  else {
    if (!['read', 'write'].includes(String(request.op))) throw new Error('DESKTOP_IO_INVALID');
    const writing = request.op === 'write';
    if (writing && typeof request.text !== 'string') throw new Error('DESKTOP_IO_INVALID');
    const file = await open(
      request.file,
      constants.O_NONBLOCK |
        constants.O_NOFOLLOW |
        (writing
          ? constants.O_WRONLY | constants.O_CREAT | (request.exclusive ? constants.O_EXCL : 0)
          : constants.O_RDONLY),
      mode,
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || (writing && metadata.nlink !== 1))
        throw new Error('DESKTOP_IO_UNSAFE');
      if (writing) {
        await file.truncate(0);
        await file.writeFile(String(request.text), 'utf8');
      } else {
        const bytes = Buffer.alloc(limit + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > limit) throw new Error('DESKTOP_IO_LIMIT');
        console.log(
          JSON.stringify({ ok: true, value: bytes.subarray(0, bytesRead).toString('utf8') }),
        );
      }
    } finally {
      await file.close();
    }
  }
  if (request.op !== 'read') console.log(JSON.stringify({ ok: true }));
} catch (error) {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.message
        : 'DESKTOP_IO_FAILED';
  console.log(
    JSON.stringify({ ok: false, error: /^[A-Z_]+$/.test(code) ? code : 'DESKTOP_IO_FAILED' }),
  );
}
