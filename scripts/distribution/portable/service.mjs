// IPC asks the official runtime's own shutdown barrier to close workers and SQLite.
// On Windows child.kill('SIGTERM') is NOT a graceful shutdown and is not used here.
process.on('message', (message) => {
  if (message === 'shutdown') process.emit('SIGINT');
});
process.on('disconnect', () => process.emit('SIGINT'));
await import('./packages/server/dist/index.js');
