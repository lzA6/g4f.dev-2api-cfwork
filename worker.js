/**
 * 欢迎使用您的全新“单文件艺术品”Cloudflare Worker 3.0 版。
 *
 * 这不再仅仅是一个代理，而是一个能自我配置的智能 API 网关。
 * 它具备以下特性：
 * 1. 统一模型目录：动态地从所有上游提供商构建。
 * 2. 智能路由核心：全自动、基于模型的路由决策。
 * 3. 简化且强大的用户体验：为 API 客户端和 UI 界面提供更优体验。
 *
 * 世界级的无服务器架构师为您服务。
 */

// =================================================================================
// ⚙️ 1. 硬编码配置
// =================================================================================

const WORKER_API_KEY = '1'; // 您的 Worker API 密钥

// 上游提供商的配置中心。这是所有智能路由和模型发现的基础。
const PROVIDER_CONFIG = {
  'api.airforce': {
    name: 'Airforce API',
    upstreamHost: 'api.airforce',
    models: ['gpt-5-mini', 'gpt-4o-mini'], // 此提供商无 models 接口，硬编码已知模型
    chatPath: '/v1/chat/completions'
  },
  'anondrop.net': {
    name: 'AnonDrop',
    upstreamHost: 'anondrop.net',
    modelsPath: '/v1/models',
    chatPath: '/v1/chat/completions'
  },
  'gpt4free.pro': {
    name: 'GPT4Free.pro',
    upstreamHost: 'gpt4free.pro',
    modelsPath: '/v1/models',
    chatPath: '/v1/chat/completions'
  },
  'gemini': {
    name: 'Google Gemini (via g4f)',
    upstreamHost: 'g4f.dev',
    modelsPath: '/api/gemini/models',
    chatPath: '/api/gemini/chat/completions'
  },
  'grok': {
    name: 'Grok (via g4f)',
    upstreamHost: 'g4f.dev',
    modelsPath: '/api/grok/models',
    chatPath: '/api/grok/chat/completions'
  },
  'pollinations.ai': {
    name: 'Pollinations.ai (via g4f)',
    upstreamHost: 'g4f.dev',
    modelsPath: '/api/pollinations.ai/models',
    chatPath: '/api/pollinations.ai/chat/completions'
  },
  'ollama': {
    name: 'Ollama (via g4f)',
    upstreamHost: 'g4f.dev',
    modelsPath: '/api/ollama/models',
    chatPath: '/api/ollama/chat/completions'
  },
  'huggingface': {
    name: 'HuggingFace (via g4f)',
    upstreamHost: 'g4f.dev',
    modelsPath: '/api/huggingface/models?inference=warm&&expand[]=inferenceProviderMapping',
    chatPath: '/api/huggingface/chat/completions'
  }
};

// =================================================================================
// 🧠 2. 智能核心：模型-提供商映射
// =================================================================================

// 全局变量，用于缓存模型-提供商的映射关系，避免重复构建。
let MODEL_PROVIDER_MAP = null;

/**
 * 动态构建模型到提供商的映射。
 * 在 Worker 首次启动时执行一次。
 */
async function buildModelProviderMap() {
  console.log("🚀 正在构建模型-提供商映射表...");
  const map = new Map();

  const fetchPromises = Object.entries(PROVIDER_CONFIG).map(async ([providerId, config]) => {
    try {
      // 1. 处理硬编码的模型
      if (config.models && !config.modelsPath) {
        config.models.forEach(modelId => {
          map.set(modelId, { providerId, upstreamHost: config.upstreamHost, chatPath: config.chatPath });
        });
        return;
      }

      // 2. 处理需要动态获取模型的提供商
      if (config.modelsPath) {
        const upstreamUrl = `https://${config.upstreamHost}${config.modelsPath}`;
        const response = await fetch(upstreamUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json', 'Origin': 'https://g4f.dev', 'Referer': 'https://g4f.dev/' }
        });
        if (!response.ok) {
          throw new Error(`上游服务返回状态 ${response.status}`);
        }
        const data = await response.json();

        // 智能解析不同格式的模型列表
        let models = [];
        if (Array.isArray(data)) { // 适用于 pollinations.ai, huggingface 等
            models = data.map(m => m.id || m.name).filter(Boolean);
        } else if (data.data && Array.isArray(data.data)) { // 适用于 OpenAI 标准格式
            models = data.data.map(m => m.id).filter(Boolean);
        } else if (data.models && Array.isArray(data.models)) { // 适用于 ollama
            models = data.models.map(m => m.name).filter(Boolean);
        }
      
        models.forEach(modelId => {
          map.set(modelId, { providerId, upstreamHost: config.upstreamHost, chatPath: config.chatPath });
        });
      }
    } catch (error) {
      console.error(`获取提供商 '${providerId}' 的模型列表失败: ${error.message}`);
    }
  });

  await Promise.allSettled(fetchPromises);
  MODEL_PROVIDER_MAP = map;
  console.log(`✅ 模型-提供商映射表构建成功。模型总数: ${MODEL_PROVIDER_MAP.size}`);
}


// =================================================================================
// 🚀 3. Worker 主入口
// =================================================================================

export default {
  async fetch(request, env, ctx) {
    // 在第一次请求时，异步构建模型映射表
    if (MODEL_PROVIDER_MAP === null) {
      // 为了简单起见，我们直接等待它完成
      await buildModelProviderMap();
      // 如果您希望在构建期间不阻塞第一个请求，可以使用 ctx.waitUntil(buildModelProviderMap());
      // 但这可能导致第一个请求找不到模型，因此等待是更稳妥的选择。
    }

    const url = new URL(request.url);

    // 统一模型列表路由
    if (url.pathname === '/v1/models') {
      return handleModelsRequest();
    }

    // 智能聊天路由
    if (url.pathname === '/v1/chat/completions') {
      return handleChatCompletionRequest(request);
    }

    // UI 路由
    if (url.pathname === '/') {
      return handleGuiRequest(request);
    }

    // 404 未找到
    return new Response('🚫 404 未找到。请访问根路径 `/` 以获取交互式界面。', { status: 404 });
  }
};


// =================================================================================
// 🔌 4. API 请求处理器
// =================================================================================

/**
 * 处理聊天请求，全自动智能路由
 */
async function handleChatCompletionRequest(request) {
  if (request.method !== 'POST') {
    return new Response('方法不允许', { status: 405 });
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${WORKER_API_KEY}`) {
    return new Response('未授权：无效的 API 密钥。', { status: 401 });
  }

  const requestBody = await request.json();
  const modelId = requestBody.model;

  if (!modelId) {
    return new Response('请求体中缺少 "model" 字段。', { status: 400 });
  }

  const providerInfo = MODEL_PROVIDER_MAP.get(modelId);

  if (!providerInfo) {
    return new Response(`找不到模型: '${modelId}'。请在 /v1/models 检查可用模型列表。`, { status: 404 });
  }

  const { upstreamHost, chatPath } = providerInfo;
  const upstreamUrl = `https://${upstreamHost}${chatPath}`;

  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', '*/*');
  headers.set('Origin', 'https://g4f.dev');
  headers.set('Referer', 'https://g4f.dev/');
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36');

  const upstreamRequest = new Request(upstreamUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(requestBody),
    redirect: 'follow'
  });

  try {
    const upstreamResponse = await fetch(upstreamRequest);
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: {
        'Content-Type': upstreamResponse.headers.get('Content-Type') || 'text/event-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      }
    });
  } catch (error) {
    return new Response(`上游 API 请求失败 (模型 '${modelId}'): ${error.message}`, { status: 502 });
  }
}

/**
 * 返回统一的、聚合后的模型列表
 */
function handleModelsRequest() {
  if (!MODEL_PROVIDER_MAP) {
    return new Response('模型目录尚未准备就绪，请稍后再试。', { status: 503 });
  }

  const modelsData = Array.from(MODEL_PROVIDER_MAP.entries()).map(([id, { providerId }]) => ({
    id,
    object: 'model',
    owned_by: providerId, // 标注模型所属的提供商
  }));

  return new Response(JSON.stringify({ object: 'list', data: modelsData }), {
    headers: { 'Content-Type': 'application/json' },
  });
}


// =================================================================================
// 🎨 5. 交互式 UI 处理器
// =================================================================================

function handleGuiRequest(request) {
  const url = new URL(request.url);
  const workerUrl = `${url.protocol}//${url.hostname}`;

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 旗舰面板 v3.0 - 智能网关</title>
    <style>
        :root {
            --bg-color: #1a1a1a; --text-color: #e0e0e0; --primary-color: #00aaff;
            --secondary-color: #252525; --border-color: #444; --pre-bg: #2d2d2d;
            --code-color: #abb2bf; --success-color: #98c379; --error-color: #e06c75;
        }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: var(--bg-color); color: var(--text-color); margin: 0; padding: 2rem; line-height: 1.6; }
        .container { max-width: 800px; margin: 0 auto; }
        header { text-align: center; margin-bottom: 3rem; border-bottom: 1px solid var(--border-color); padding-bottom: 1rem; }
        h1 { color: var(--primary-color); font-size: 2.5rem; margin: 0; }
        h2 { color: var(--primary-color); border-bottom: 2px solid var(--border-color); padding-bottom: 0.5rem; margin-top: 2.5rem; }
        section { background-color: var(--secondary-color); border-radius: 8px; padding: 1.5rem; margin-bottom: 2rem; box-shadow: 0 4px 8px rgba(0,0,0,0.2); }
        pre { background-color: var(--pre-bg); color: var(--code-color); padding: 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; cursor: copy; position: relative; }
        pre::after { content: '点击复制'; position: absolute; top: 5px; right: 10px; font-size: 0.8em; color: #fff; background: rgba(255,255,255,0.2); padding: 2px 6px; border-radius: 4px; opacity: 0; transition: opacity 0.2s; }
        pre:hover::after { opacity: 1; }
        code { font-family: 'Fira Code', 'Courier New', monospace; }
        .api-tester textarea, .api-tester select { width: 100%; box-sizing: border-box; background-color: var(--pre-bg); color: var(--text-color); border: 1px solid var(--border-color); border-radius: 6px; padding: 0.8rem; margin-bottom: 1rem; }
        .api-tester button { background-color: var(--primary-color); color: #fff; border: none; padding: 0.8rem 1.5rem; border-radius: 6px; cursor: pointer; font-size: 1rem; transition: background-color 0.2s; }
        .api-tester button:disabled { background-color: #555; cursor: not-allowed; }
        .api-tester button:hover:not(:disabled) { background-color: #0088cc; }
        #result-output { min-height: 100px; margin-top: 1rem; border: 1px dashed var(--border-color); }
        .loading-text { color: var(--primary-color); animation: blink 1.5s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        footer { text-align: center; margin-top: 3rem; color: #888; font-size: 0.9em; }
        .model-option-provider { font-size: 0.8em; color: #888; margin-left: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>✨ API 旗舰面板 v3.0 ✨</h1>
            <p>一个拥有自主意识的智能模型网关</p>
        </header>

        <main>
            <section>
                <h2>🧠 智能路由核心</h2>
                <p>本 Worker 已升级为智能网关。您<strong>无需关心模型来自哪个提供商</strong>，只需在请求中指定 <code>model</code> 名称，Worker 将自动为您路由到正确的上游服务。</p>
            </section>

            <section>
                <h2>📋 即用信息</h2>
                <p>将以下信息填入任何兼容 OpenAI 的第三方客户端即可使用。</p>
              
                <strong>API 地址 (Base URL):</strong>
                <pre><code>${workerUrl}/v1</code></pre>

                <strong>API 密钥 (API Key):</strong>
                <pre><code>${WORKER_API_KEY}</code></pre>

                <strong>模型名称 (Model Name):</strong>
                <p>请在客户端的模型列表中选择或填写下方“在线测试”中列出的任意模型ID。</p>
            </section>

            <section class="api-tester">
                <h2>🚀 在线 API 测试</h2>
                <p>从聚合的全局模型库中选择一个模型进行测试。</p>
                <label for="modelSelect"><strong>1. 选择模型 (聚合自所有提供商):</strong></label>
                <select id="modelSelect"><option>🔄 正在构建模型目录...</option></select>
              
                <label for="prompt-input"><strong>2. 输入问题:</strong></label>
                <textarea id="prompt-input" placeholder="在这里输入你的问题..."></textarea>
                <button id="send-button">发送</button>
              
                <strong>AI 回答:</strong>
                <pre id="result-output"><code id="result-code">... 等待您的指令 ...</code></pre>
            </section>
        </main>

        <footer>
            <p>由世界级的无服务器架构师为您倾力打造</p>
        </footer>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const modelSelect = document.getElementById('modelSelect');
            const sendButton = document.getElementById('send-button');
            const promptInput = document.getElementById('prompt-input');
            const resultCode = document.getElementById('result-code');
            const resultOutput = document.getElementById('result-output');

            // 复制功能
            document.querySelectorAll('pre').forEach(pre => {
                pre.addEventListener('click', () => {
                    navigator.clipboard.writeText(pre.querySelector('code').innerText)
                        .then(() => {
                            const originalText = pre.dataset.originalText || pre.querySelector('code').innerText;
                            pre.dataset.originalText = originalText;
                            pre.querySelector('code').innerText = '✅ 已复制!';
                            setTimeout(() => { pre.querySelector('code').innerText = originalText; }, 1500);
                        });
                });
            });

            // 加载统一的模型列表
            async function loadModels() {
                modelSelect.disabled = true;
                try {
                    const response = await fetch('/v1/models');
                    if (!response.ok) throw new Error(await response.text());
                  
                    const modelsData = await response.json();
                    if (modelsData.data && modelsData.data.length > 0) {
                        // 按提供商分组
                        const groupedModels = modelsData.data.reduce((acc, model) => {
                            const provider = model.owned_by || '未知';
                            if (!acc[provider]) acc[provider] = [];
                            acc[provider].push(model);
                            return acc;
                        }, {});

                        let html = '';
                        for (const provider in groupedModels) {
                            html += \`<optgroup label="\${provider}">\`;
                            html += groupedModels[provider].map(m => \`<option value="\${m.id}">\${m.id}</option>\`).join('');
                            html += \`</optgroup>\`;
                        }
                        modelSelect.innerHTML = html;
                    } else {
                        modelSelect.innerHTML = '<option>无可用模型</option>';
                    }
                } catch (error) {
                    console.error('加载模型列表失败:', error);
                    modelSelect.innerHTML = \`<option>加载模型失败</option>\`;
                } finally {
                    modelSelect.disabled = false;
                }
            }

            sendButton.addEventListener('click', async () => {
                const model = modelSelect.value;
                const prompt = promptInput.value.trim();

                if (!model || !prompt) {
                    alert('请确保已选择模型并输入了问题！');
                    return;
                }

                sendButton.disabled = true;
                resultCode.innerHTML = '<span class="loading-text">🧠 正在思考...</span>';

                try {
                    const response = await fetch('/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': \`Bearer ${WORKER_API_KEY}\`
                        },
                        body: JSON.stringify({
                            model: model,
                            messages: [{ role: 'user', content: prompt }],
                            stream: true
                        })
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(\`API 错误: \${response.status} \${response.statusText} - \${errorText}\`);
                    }

                    resultCode.innerHTML = '';
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder('utf-8');
                  
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\\n\\n').filter(line => line.trim());

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const dataStr = line.substring(6).trim();
                                if (dataStr === '[DONE]') break;
                                try {
                                    const data = JSON.parse(dataStr);
                                    if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
                                        resultCode.textContent += data.choices[0].delta.content;
                                        resultOutput.scrollTop = resultOutput.scrollHeight;
                                    }
                                } catch (e) { 
                                    // 忽略非 JSON 块的解析错误
                                }
                            }
                        }
                    }

                } catch (error) {
                    resultCode.innerHTML = \`<span style="color: var(--error-color);">请求失败: \${error.message}</span>\`;
                } finally {
                    sendButton.disabled = false;
                }
            });

            // 初始化
            loadModels();
        });
    </script>
</body>
</html>
  `;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
