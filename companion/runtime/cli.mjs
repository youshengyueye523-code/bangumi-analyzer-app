import { AnalyzerSupervisor } from './supervisor.mjs';

// Private stdio transport only. No HTTP listener, web-origin access, arbitrary paths, URLs or PIDs in requests.
let supervisor, pending = 0, closing = false;
const send = value => {
  try { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + '\n'); }
  catch { /* A broken host pipe cannot receive a diagnostic; its error handler requests safe shutdown. */ }
};
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 && args.length !== 4) throw new Error();
  if (args[0] !== '--packageRoot' || (args.length === 4 && (args[2] !== '--port' || !/^\d+$/.test(args[3])))) throw new Error();
  supervisor = new AnalyzerSupervisor({ packageRoot: args[1], port: args.length === 4 ? Number(args[3]) : 0 });
} catch {
  send({ id: null, ok: false, error: { code: 'INVALID_ARGUMENTS', message: '用法：cli.mjs --packageRoot <独立分发绝对目录> [--port <非8787端口，默认0>]' } });
  process.exitCode = 1;
}
if (supervisor) {
  const close = async () => {
    if (closing) return;
    closing = true;
    const result = await supervisor.stopAnalyzer();
    send({ event: 'transportClosing', ...result });
    if (!result.ok || result.status.ownsProcess) process.exitCode = 1;
    // Never process.exit/kill a still-draining child; IPC remains connected until actual exit.
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
  process.stdout.on('error', () => void close());
  process.stdin.setEncoding('utf8');
  let buffer = '', dropping = false;
  const invalid = (code = 'INVALID_REQUEST', id = null) => send({ id, ok: false, error: { code, message: '仅接受整数 id 与允许的方法；不接受参数或任意命令。' } });
  const dispatch = line => {
    let request;
    try {
      request = JSON.parse(line);
      if (!request || !Number.isSafeInteger(request.id) || request.id < 0 ||
          !['getStatus', 'startAnalyzer', 'stopAnalyzer', 'openAnalyzer'].includes(request.method) ||
          Object.keys(request).some(k => k !== 'id' && k !== 'method')) throw new Error();
    } catch { invalid(); return; }
    if (closing || pending >= 8) { invalid('BUSY', request.id); return; }
    pending++;
    void (async () => {
      try {
        const result = request.method === 'getStatus' ? { ok: true, status: supervisor.getStatus() } : await supervisor[request.method]();
        send({ id: request.id, ...result });
      } catch { send({ id: request.id, ok: false, error: { code: 'INTERNAL', message: '运行核心操作失败，未输出底层错误。' } }); }
      finally { pending--; }
    })();
  };
  process.stdin.on('data', chunk => {
    for (const fragment of chunk.split(/(?<=\n)/)) {
      if (!dropping) buffer += fragment;
      if (buffer.length > 4096) { buffer = ''; dropping = true; }
      if (fragment.endsWith('\n')) {
        if (dropping) invalid(); else if (buffer.trim()) dispatch(buffer);
        buffer = ''; dropping = false;
      }
    }
  });
  process.stdin.on('end', () => {
    if (buffer.trim() || dropping) invalid(); // A request must be a complete newline-delimited frame.
    void close();
  });
  process.stdin.on('error', () => void close());
}
