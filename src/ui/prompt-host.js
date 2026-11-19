/** 与父宿主协商 Zotero 的只读调用并接收检索结果。 */
let requestSequence = 0;
function rpc(view, method, params, targetOrigin, waitMs) {
  const id = ++requestSequence;
  return new Promise(resolve => {
    const finish = response => {
      clearTimeout(timer);
      view.removeEventListener('message', receive);
      resolve(response);
    };
    const receive = event => {
      if (event.source !== view.parent || !event.origin || event.origin === 'null'
        || (targetOrigin !== '*' && event.origin !== targetOrigin)) return;
      const data = event.data;
      if (data?.jsonrpc !== '2.0' || data.id !== id) return;
      finish({ origin: event.origin, data });
    };
    const timer = setTimeout(() => finish(null), waitMs);
    view.addEventListener('message', receive);
    try { view.parent.postMessage({ jsonrpc: '2.0', id, method, params }, targetOrigin); }
    catch { finish(null); }
  });
}

export async function connectPromptHost(view, waitMs = 3000, onToolResult) {
  if (view.parent === view) return null;
  // 初始化不带论文身份或内容。收到的消息必须来自本页面的父宿主。
  const initialized = await rpc(view, 'ui/initialize', {
    protocolVersion: '2026-01-26', appInfo: { name: 'AIdea Zotero MCP', version: '0.1.0' }, appCapabilities: {},
  }, '*', waitMs);
  if (!initialized?.data.result) return null;
  const { origin, data: { result } } = initialized;
  const capabilities = result.hostCapabilities;
  // Subscribe before acknowledging initialization so an immediate result is received.
  if (onToolResult) view.addEventListener('message', event => {
    if (event.source === view.parent && event.origin === origin && event.data?.jsonrpc === '2.0'
      && event.data.method === 'ui/notifications/tool-result') onToolResult(event.data.params);
  });
  view.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, origin);
  if (!capabilities?.serverTools) return null;

  return {
    callTool: capabilities.serverTools ? async args => {
      const reply = await rpc(view, 'tools/call', { name: 'zotero-app-read', arguments: args }, origin, 12000);
      const result = reply?.data.result;
      const content = result?.content?.find(item => item.type === 'text');
      if (!content || result.isError) throw new Error('右侧 Zotero 读取失败，请稍后重试。');
      return JSON.parse(content.text);
    } : undefined,
  };
}
