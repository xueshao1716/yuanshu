process.stdin.on('data', d => {
  for (const l of String(d).split('\n')) {
    if (!l.trim()) continue;
    const m = JSON.parse(l);
    if (m.id === undefined) continue;
    const result = m.method === 'tools/list' ? { tools: [{ name: 'ping', description: '', inputSchema: { type: 'object', properties: {} } }] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
  }
});
