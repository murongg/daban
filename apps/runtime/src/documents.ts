import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DocumentUpload, isDocumentUpload, isKnowledgeContent } from '@daban/protocol';
import { errorCode, Fault } from './control.js';

export class Documents {
  private pending?: Promise<string>;
  private abort?: AbortController;
  private closed = false;
  extract(file: DocumentUpload, signal?: AbortSignal): Promise<string> {
    if (
      !isDocumentUpload(file) ||
      Buffer.from(file.data, 'base64').toString('base64') !== file.data
    )
      return Promise.reject(new Fault('INVALID_DOCUMENT', 400));
    if (this.closed) return Promise.reject(new Fault('DOCUMENT_UNAVAILABLE', 503));
    if (this.pending) return Promise.reject(new Fault('DOCUMENT_BUSY', 409));
    if (process.platform !== 'linux') return Promise.reject(new Fault('DOCUMENT_UNAVAILABLE', 503));
    const abort = new AbortController();
    this.abort = abort;
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const pending = this.launch(file, combined).finally(() => {
      this.pending = undefined;
      this.abort = undefined;
    });
    this.pending = pending;
    return pending;
  }
  private async launch(file: DocumentUpload, signal: AbortSignal) {
    signal.throwIfAborted();
    const root = await realpath(fileURLToPath(new URL('..', import.meta.url))),
      dependencies = await realpath(
        fileURLToPath(new URL('./node_modules', import.meta.url)),
      ).catch(() => {
        throw new Fault('DOCUMENT_UNAVAILABLE', 503);
      }),
      engine = path.dirname(path.dirname(await realpath(process.execPath)));
    signal.throwIfAborted();
    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-user',
      '--unshare-all',
      '--disable-userns',
      '--cap-drop',
      'ALL',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/lib',
      '/lib',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--ro-bind',
      root,
      '/app',
      '--ro-bind',
      dependencies,
      '/app/runtime/node_modules',
      '--ro-bind',
      engine,
      '/engine',
      '--chdir',
      '/tmp',
      '--clearenv',
      '--setenv',
      'HOME',
      '/tmp',
      '--setenv',
      'LANG',
      'C.UTF-8',
      '--setenv',
      'PATH',
      '/usr/bin:/bin',
      '--',
      '/usr/bin/prlimit',
      '--cpu=20',
      '--',
      '/engine/bin/node',
      '--max-old-space-size=256',
      '/app/runtime/extract.js',
      file.name.split('.').at(-1)!.toLowerCase(),
    ];
    return new Promise<string>((resolve, reject) => {
      // Never parse in the credential-bearing harness process or fall back to an unsandboxed worker.
      const child = spawn('bwrap', args, {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
        killSignal: 'SIGKILL',
        signal,
      });
      const output: Buffer[] = [];
      let bytes = 0,
        limited = false,
        failure: Error | undefined;
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1500000) {
          limited = true;
          child.kill('SIGKILL');
        } else output.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1500000) {
          limited = true;
          child.kill('SIGKILL');
        }
      });
      child.stdin.on('error', (error) => {
        if (errorCode(error) !== 'EPIPE') failure = error;
      });
      child.once('error', (error) => {
        failure = error;
      });
      child.once('close', (code, killed) => {
        try {
          signal.throwIfAborted();
          if (errorCode(failure) === 'ENOENT') throw new Fault('DOCUMENT_UNAVAILABLE', 503);
          if (limited || killed) throw new Fault('DOCUMENT_LIMIT', 413);
          if (failure || code !== 0) throw new Fault('DOCUMENT_UNREADABLE', 400);
          const result: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
          if (!result || typeof result !== 'object') throw new Fault('DOCUMENT_UNREADABLE', 400);
          const value = result as Record<string, unknown>;
          if (
            [
              'DOCUMENT_EMPTY',
              'DOCUMENT_ENCRYPTED',
              'DOCUMENT_INCOMPLETE',
              'DOCUMENT_LIMIT',
              'DOCUMENT_UNREADABLE',
            ].includes(String(value.error))
          )
            throw new Fault(String(value.error), 400);
          if (!isKnowledgeContent(value.content) || !value.content.trim())
            throw new Fault('DOCUMENT_UNREADABLE', 400);
          resolve(value.content);
        } catch (error) {
          reject(
            error instanceof Fault || signal.aborted
              ? error
              : new Fault('DOCUMENT_UNREADABLE', 400),
          );
        }
      });
      child.stdin.end(Buffer.from(file.data, 'base64'));
    });
  }
  async close() {
    this.closed = true;
    this.abort?.abort();
    await this.pending?.catch(() => {});
  }
}
