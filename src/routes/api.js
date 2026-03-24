/**
 * @file API 路由模块
 * @description 定义所有 API 路由及请求处理逻辑
 *              - GET  /v1/models              获取模型列表
 *              - POST /v1/chat/completions     标准 OpenAI 聊天补全（自动格式转换）
 *              - POST /v1/responses            OpenAI Responses API 直接转发
 *              - POST /v1/messages             Anthropic Messages API 直接转发
 *              - POST /v1/messages/count_tokens Anthropic 计算 token 数
 */

import fs from 'fs';
import express from 'express';
import fetch from 'node-fetch';
import {
  getConfig,
  getModelById,
  getEndpointByType,
  getSystemPrompt,
  getModelReasoning,
  getRedirectedModelId,
  getModelProvider,
  getRetryConfig,
  CONFIG_PATH,
  loadConfig,
} from '../config/index.js';
import { logInfo, logDebug, logError, logRequest, logResponse } from '../utils/logger.js';
import { transformToAnthropic, getAnthropicHeaders } from '../transformers/request-anthropic.js';
import { transformToOpenAI, getOpenAIHeaders } from '../transformers/request-openai.js';
import { transformToCommon, getCommonHeaders } from '../transformers/request-common.js';
import { AnthropicResponseTransformer } from '../transformers/response-anthropic.js';
import { OpenAIResponseTransformer } from '../transformers/response-openai.js';
import {
  getApiKeyWithMeta,
  addRefreshKey,
  removeRefreshKey,
  getAuthStatus,
  lockAccount,
  unlockAccount,
} from '../services/auth.js';
import { getNextProxyAgent } from '../services/proxy-manager.js';

const router = express.Router();

// ======================== 辅助函数 ========================

/**
 * 将 /v1/responses 格式的响应转换为 /v1/chat/completions 格式
 * 用于非流式 OpenAI 请求的响应兼容
 * @param {object} resp - Responses API 的响应对象
 * @returns {object} chat/completions 格式的响应
 */
function convertResponseToChatCompletion(resp) {
  if (!resp || typeof resp !== 'object') {
    throw new Error('无效的响应对象');
  }

  const outputMsg = (resp.output || []).find((o) => o.type === 'message');
  const textBlocks = outputMsg?.content?.filter((c) => c.type === 'output_text') || [];
  const content = textBlocks.map((c) => c.text).join('');

  return {
    id: resp.id ? resp.id.replace(/^resp_/, 'chatcmpl-') : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: resp.created_at || Math.floor(Date.now() / 1000),
    model: resp.model || 'unknown-model',
    choices: [
      {
        index: 0,
        message: {
          role: outputMsg?.role || 'assistant',
          content: content || '',
        },
        finish_reason: resp.status === 'completed' ? 'stop' : 'unknown',
      },
    ],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: resp.usage?.total_tokens ?? 0,
    },
  };
}

/**
 * 将 Anthropic Messages API 的非流式响应转换为 chat/completions 格式
 * @param {object} resp - Anthropic 响应对象
 * @returns {object} chat/completions 格式的响应
 */
function convertAnthropicToChatCompletion(resp) {
  if (!resp || typeof resp !== 'object') {
    throw new Error('无效的 Anthropic 响应对象');
  }

  const contentBlocks = resp.content || [];

  // 提取文本内容
  const textBlocks = contentBlocks.filter((c) => c.type === 'text');
  const textContent = textBlocks.map((c) => c.text).join('');

  // 提取 tool_use 内容并转换为 OpenAI tool_calls 格式
  const toolUseBlocks = contentBlocks.filter((c) => c.type === 'tool_use');
  const toolCalls = toolUseBlocks.map((block, index) => ({
    id: block.id || `call_${Date.now()}_${index}`,
    type: 'function',
    function: {
      name: block.name,
      arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
    },
  }));

  // 映射停止原因
  const stopReasonMap = {
    end_turn: 'stop',
    max_tokens: 'length',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
  };

  // 构建 message 对象
  const message = {
    role: resp.role || 'assistant',
    content: textContent || null,
  };

  // 如果有工具调用，添加 tool_calls 字段
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: resp.id ? resp.id.replace(/^msg_/, 'chatcmpl-') : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model || 'unknown-model',
    choices: [
      {
        index: 0,
        message,
        finish_reason: stopReasonMap[resp.stop_reason] || 'stop',
      },
    ],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}

/**
 * 获取客户端认证头
 */
function getClientAuth(req) {
  const fromXApiKey = req.headers['x-api-key'] ? `Bearer ${req.headers['x-api-key']}` : null;
  return req.headers.authorization || fromXApiKey || null;
}

/**
 * 带重试的代理请求
 * 当上游返回可锁定状态码时，自动锁定当前账户并切换到下一个账户重试
 * @param {object} req - Express 请求对象
 * @param {string} url - 目标 URL
 * @param {Function} buildHeadersFn - (authHeader) => headers 的函数
 * @param {object} body - 请求体
 * @returns {Promise<Response>} 上游响应
 */
async function proxyWithRetry(req, url, buildHeadersFn, body) {
  const { maxRetries, lockStatusCodes } = getRetryConfig();
  const clientAuth = getClientAuth(req);
  const excludeIndices = new Set();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 获取认证
    const { authorization, accountIndex } = await getApiKeyWithMeta(clientAuth, excludeIndices);
    const headers = buildHeadersFn(authorization);

    // 发送请求
    const proxyAgentInfo = getNextProxyAgent(url);
    const fetchOptions = { method: 'POST', headers, body: JSON.stringify(body) };
    if (proxyAgentInfo?.agent) fetchOptions.agent = proxyAgentInfo.agent;

    logRequest('POST', url, headers, body);
    const response = await fetch(url, fetchOptions);
    logInfo(`响应状态: ${response.status}`);

    // 检查是否需要锁定并重试
    if (lockStatusCodes.includes(response.status) && accountIndex >= 0) {
      const errorText = await response.text();
      lockAccount(accountIndex, `HTTP ${response.status}`);
      excludeIndices.add(accountIndex);

      if (attempt < maxRetries) {
        logInfo(`账户 #${accountIndex} 已锁定(${response.status})，重试 ${attempt + 1}/${maxRetries}...`);
        continue;
      }
      // 最后一次重试也失败，返回错误
      return { ok: false, status: response.status, errorText };
    }

    return response;
  }

  throw new Error('所有重试均失败');
}

/**
 * 创建代理请求并发送（简版，无重试）
 */
async function proxyFetch(url, headers, body) {
  const proxyAgentInfo = getNextProxyAgent(url);
  const fetchOptions = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  };
  if (proxyAgentInfo?.agent) {
    fetchOptions.agent = proxyAgentInfo.agent;
  }
  return fetch(url, fetchOptions);
}

// ======================== 路由处理函数 ========================

/**
 * GET /v1/models - 获取可用模型列表
 */
router.get('/v1/models', (req, res) => {
  logInfo('GET /v1/models');

  try {
    const config = getConfig();
    const models = config.models.map((model) => ({
      id: model.id,
      object: 'model',
      created: Date.now(),
      owned_by: model.type,
      permission: [],
      root: model.id,
      parent: null,
    }));

    const response = { object: 'list', data: models };
    logResponse(200, null, response);
    res.json(response);
  } catch (error) {
    logError('GET /v1/models 处理出错', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/chat/completions - 标准 OpenAI 聊天补全
 * 自动根据模型类型转换请求格式并路由到对应端点
 */
async function handleChatCompletions(req, res) {
  logInfo('POST /v1/chat/completions');

  try {
    const openaiRequest = req.body;
    const modelId = getRedirectedModelId(openaiRequest.model);

    if (!modelId) return res.status(400).json({ error: 'model 参数是必需的' });

    const model = getModelById(modelId);
    if (!model) return res.status(404).json({ error: `模型 ${modelId} 未找到` });

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) return res.status(500).json({ error: `端点类型 ${model.type} 未配置` });

    logInfo(`路由到 ${model.type} 端点: ${endpoint.base_url}`);

    const clientHeaders = req.headers;
    const requestWithRedirectedModel = { ...openaiRequest, model: modelId };
    const provider = getModelProvider(modelId);

    // 根据端点类型进行请求转换
    let transformedRequest;
    if (model.type === 'anthropic') {
      transformedRequest = transformToAnthropic(requestWithRedirectedModel);
    } else if (model.type === 'openai') {
      transformedRequest = transformToOpenAI(requestWithRedirectedModel);
    } else if (model.type === 'common') {
      transformedRequest = transformToCommon(requestWithRedirectedModel);
    } else {
      return res.status(500).json({ error: `未知的端点类型: ${model.type}` });
    }

    // 构建请求头的函数（认证头由 proxyWithRetry 注入）
    const buildHeaders = (authHeader) => {
      if (model.type === 'anthropic') {
        const isStreaming = openaiRequest.stream === true;
        return getAnthropicHeaders(authHeader, clientHeaders, isStreaming, modelId, provider);
      } else if (model.type === 'openai') {
        return getOpenAIHeaders(authHeader, clientHeaders, provider);
      } else {
        return getCommonHeaders(authHeader, clientHeaders, provider);
      }
    };

    // 带重试的代理请求
    const response = await proxyWithRetry(req, endpoint.base_url, buildHeaders, transformedRequest);

    if (response.errorText) {
      return res.status(response.status).json({ error: `端点返回 ${response.status}`, details: response.errorText });
    }

    if (!response.ok) {
      const errorText = await response.text();
      logError(`端点错误: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({ error: `端点返回 ${response.status}`, details: errorText });
    }

    const isStreaming = transformedRequest.stream === true;

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      if (model.type === 'common') {
        try { for await (const chunk of response.body) { res.write(chunk); } res.end(); logInfo('流式响应已转发'); }
        catch (e) { logError('流式传输错误', e); res.end(); }
      } else {
        const transformer = model.type === 'anthropic'
          ? new AnthropicResponseTransformer(modelId, `chatcmpl-${Date.now()}`)
          : new OpenAIResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        try { for await (const chunk of transformer.transformStream(response.body)) { res.write(chunk); } res.end(); logInfo('流式响应已完成'); }
        catch (e) { logError('流式传输错误', e); res.end(); }
      }
    } else {
      const data = await response.json();
      if (model.type === 'openai') {
        try { res.json(convertResponseToChatCompletion(data)); } catch (e) { res.json(data); }
      } else if (model.type === 'anthropic') {
        try { res.json(convertAnthropicToChatCompletion(data)); } catch (e) { res.json(data); }
      } else {
        res.json(data);
      }
    }
  } catch (error) {
    logError('/v1/chat/completions 处理出错', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

/**
 * POST /v1/responses - 直接转发到 OpenAI Responses API
 */
async function handleDirectResponses(req, res) {
  logInfo('POST /v1/responses');
  try {
    const openaiRequest = req.body;
    const modelId = getRedirectedModelId(openaiRequest.model);
    if (!modelId) return res.status(400).json({ error: 'model 参数是必需的' });
    const model = getModelById(modelId);
    if (!model) return res.status(404).json({ error: `模型 ${modelId} 未找到` });
    if (model.type !== 'openai') return res.status(400).json({ error: '端点类型不匹配', message: `/v1/responses 仅支持 openai 类型` });
    const endpoint = getEndpointByType(model.type);
    if (!endpoint) return res.status(500).json({ error: `端点类型 ${model.type} 未配置` });

    const clientHeaders = req.headers;
    const provider = getModelProvider(modelId);
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...openaiRequest, model: modelId };
    if (systemPrompt) { modifiedRequest.instructions = modifiedRequest.instructions ? systemPrompt + modifiedRequest.instructions : systemPrompt; }
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') { /* keep */ }
    else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) { modifiedRequest.reasoning = { effort: reasoningLevel, summary: 'auto' }; }
    else { delete modifiedRequest.reasoning; }

    const response = await proxyWithRetry(req, endpoint.base_url, (auth) => getOpenAIHeaders(auth, clientHeaders, provider), modifiedRequest);
    if (response.errorText) return res.status(response.status).json({ error: `端点返回 ${response.status}`, details: response.errorText });
    if (!response.ok) { const t = await response.text(); return res.status(response.status).json({ error: `端点返回 ${response.status}`, details: t }); }

    if (openaiRequest.stream === true) {
      res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
      try { for await (const chunk of response.body) { res.write(chunk); } res.end(); } catch (e) { res.end(); }
    } else { res.json(await response.json()); }
  } catch (error) { logError('/v1/responses 出错', error); res.status(500).json({ error: 'Internal server error', message: error.message }); }
}

/**
 * POST /v1/messages - 直接转发到 Anthropic Messages API
 */
async function handleDirectMessages(req, res) {
  logInfo('POST /v1/messages');
  try {
    const anthropicRequest = req.body;
    const modelId = getRedirectedModelId(anthropicRequest.model);
    if (!modelId) return res.status(400).json({ error: 'model 参数是必需的' });
    const model = getModelById(modelId);
    if (!model) return res.status(404).json({ error: `模型 ${modelId} 未找到` });
    if (model.type !== 'anthropic') return res.status(400).json({ error: '端点类型不匹配', message: `/v1/messages 仅支持 anthropic 类型` });
    const endpoint = getEndpointByType(model.type);
    if (!endpoint) return res.status(500).json({ error: `端点类型 ${model.type} 未配置` });

    const clientHeaders = req.headers;
    const provider = getModelProvider(modelId);
    const isStreaming = anthropicRequest.stream === true;
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...anthropicRequest, model: modelId };
    if (systemPrompt) {
      if (modifiedRequest.system && Array.isArray(modifiedRequest.system)) { modifiedRequest.system = [{ type: 'text', text: systemPrompt }, ...modifiedRequest.system]; }
      else { modifiedRequest.system = [{ type: 'text', text: systemPrompt }]; }
    }
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') { /* keep */ }
    else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) { const bt = { low: 4096, medium: 12288, high: 24576, xhigh: 40960 }; modifiedRequest.thinking = { type: 'enabled', budget_tokens: bt[reasoningLevel] }; }
    else { delete modifiedRequest.thinking; }

    const response = await proxyWithRetry(req, endpoint.base_url, (auth) => getAnthropicHeaders(auth, clientHeaders, isStreaming, modelId, provider), modifiedRequest);
    if (response.errorText) return res.status(response.status).json({ error: `端点返回 ${response.status}`, details: response.errorText });
    if (!response.ok) { const t = await response.text(); return res.status(response.status).json({ error: `端点返回 ${response.status}`, details: t }); }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
      try { for await (const chunk of response.body) { res.write(chunk); } res.end(); } catch (e) { res.end(); }
    } else { res.json(await response.json()); }
  } catch (error) { logError('/v1/messages 出错', error); res.status(500).json({ error: 'Internal server error', message: error.message }); }
}

/**
 * POST /v1/messages/count_tokens - Anthropic token 计数
 */
async function handleCountTokens(req, res) {
  logInfo('POST /v1/messages/count_tokens');
  try {
    const anthropicRequest = req.body;
    const modelId = getRedirectedModelId(anthropicRequest.model);
    if (!modelId) return res.status(400).json({ error: 'model 参数是必需的' });
    const model = getModelById(modelId);
    if (!model) return res.status(404).json({ error: `模型 ${modelId} 未找到` });
    if (model.type !== 'anthropic') return res.status(400).json({ error: '端点类型不匹配' });
    const endpoint = getEndpointByType('anthropic');
    if (!endpoint) return res.status(500).json({ error: '端点类型 anthropic 未配置' });

    const clientHeaders = req.headers;
    const provider = getModelProvider(modelId);
    const countTokensUrl = endpoint.base_url.replace('/v1/messages', '/v1/messages/count_tokens');
    const modifiedRequest = { ...anthropicRequest, model: modelId };

    const response = await proxyWithRetry(req, countTokensUrl, (auth) => getAnthropicHeaders(auth, clientHeaders, false, modelId, provider), modifiedRequest);
    if (response.errorText) return res.status(response.status).json({ error: `端点返回 ${response.status}`, details: response.errorText });
    if (!response.ok) { const t = await response.text(); return res.status(response.status).json({ error: `端点返回 ${response.status}`, details: t }); }

    res.json(await response.json());
  } catch (error) { logError('/v1/messages/count_tokens 出错', error); res.status(500).json({ error: 'Internal server error', message: error.message }); }
}

// ======================== 注册路由 ========================

router.post('/v1/chat/completions', handleChatCompletions);
router.post('/v1/responses', handleDirectResponses);
router.post('/v1/messages', handleDirectMessages);
router.post('/v1/messages/count_tokens', handleCountTokens);

// ======================== 认证管理 API ========================

router.get('/api/auth/status', (req, res) => { res.json(getAuthStatus()); });

router.post('/api/auth/keys', async (req, res) => {
  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || key.trim() === '') return res.status(400).json({ error: '请提供 key 字段' });
  try { res.json(await addRefreshKey(key)); }
  catch (error) { logError('添加令牌失败', error); res.status(400).json({ error: '令牌验证失败', message: error.message }); }
});

router.delete('/api/auth/keys/:index', (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (isNaN(index)) return res.status(400).json({ error: '无效的索引' });
  res.json(removeRefreshKey(index));
});

router.post('/api/auth/keys/:index/unlock', (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (isNaN(index)) return res.status(400).json({ error: '无效的索引' });
  res.json(unlockAccount(index));
});

// ======================== 配置管理 API ========================

router.get('/api/config', (req, res) => {
  try { res.type('text/yaml').send(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/config', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content) return res.status(400).json({ error: '请提供 content 字段' });
    fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
    // 热加载会自动触发
    res.json({ success: true, message: '配置已保存（热加载将自动生效）' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
