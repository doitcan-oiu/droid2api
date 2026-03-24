/**
 * @file API 路由模块
 * @description 定义所有 API 路由及请求处理逻辑
 *              - GET  /v1/models              获取模型列表
 *              - POST /v1/chat/completions     标准 OpenAI 聊天补全（自动格式转换）
 *              - POST /v1/responses            OpenAI Responses API 直接转发
 *              - POST /v1/messages             Anthropic Messages API 直接转发
 *              - POST /v1/messages/count_tokens Anthropic 计算 token 数
 */

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
} from '../config/index.js';
import { logInfo, logDebug, logError, logRequest, logResponse } from '../utils/logger.js';
import { transformToAnthropic, getAnthropicHeaders } from '../transformers/request-anthropic.js';
import { transformToOpenAI, getOpenAIHeaders } from '../transformers/request-openai.js';
import { transformToCommon, getCommonHeaders } from '../transformers/request-common.js';
import { AnthropicResponseTransformer } from '../transformers/response-anthropic.js';
import { OpenAIResponseTransformer } from '../transformers/response-openai.js';
import { getApiKey } from '../services/auth.js';
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
 * 通用的 API Key 获取封装
 * @param {object} req - Express 请求对象
 * @returns {Promise<string|null>} 认证头字符串，失败时返回 null 并向客户端返回错误
 */
async function resolveAuthHeader(req, res) {
  try {
    const clientAuthFromXApiKey = req.headers['x-api-key']
      ? `Bearer ${req.headers['x-api-key']}`
      : null;
    return await getApiKey(req.headers.authorization || clientAuthFromXApiKey);
  } catch (error) {
    logError('获取 API Key 失败', error);
    res.status(500).json({
      error: 'API key not available',
      message: '获取或刷新 API Key 失败，请检查服务器日志。',
    });
    return null;
  }
}

/**
 * 创建代理请求并发送
 * @param {string} url - 目标 URL
 * @param {object} headers - 请求头
 * @param {object} body - 请求体
 * @returns {Promise<Response>}
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

    if (!modelId) {
      return res.status(400).json({ error: 'model 参数是必需的' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `模型 ${modelId} 未找到` });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `端点类型 ${model.type} 未配置` });
    }

    logInfo(`路由到 ${model.type} 端点: ${endpoint.base_url}`);

    // 获取认证头
    const authHeader = await resolveAuthHeader(req, res);
    if (!authHeader) return;

    const clientHeaders = req.headers;
    logDebug('客户端请求头', {
      'x-factory-client': clientHeaders['x-factory-client'],
      'x-session-id': clientHeaders['x-session-id'],
      'user-agent': clientHeaders['user-agent'],
    });

    // 更新模型ID（重定向后）
    const requestWithRedirectedModel = { ...openaiRequest, model: modelId };
    const provider = getModelProvider(modelId);

    // 根据端点类型进行请求转换
    let transformedRequest;
    let headers;

    if (model.type === 'anthropic') {
      transformedRequest = transformToAnthropic(requestWithRedirectedModel);
      const isStreaming = openaiRequest.stream === true;
      headers = getAnthropicHeaders(authHeader, clientHeaders, isStreaming, modelId, provider);
    } else if (model.type === 'openai') {
      transformedRequest = transformToOpenAI(requestWithRedirectedModel);
      headers = getOpenAIHeaders(authHeader, clientHeaders, provider);
    } else if (model.type === 'common') {
      transformedRequest = transformToCommon(requestWithRedirectedModel);
      headers = getCommonHeaders(authHeader, clientHeaders, provider);
    } else {
      return res.status(500).json({ error: `未知的端点类型: ${model.type}` });
    }

    logRequest('POST', endpoint.base_url, headers, transformedRequest);

    const response = await proxyFetch(endpoint.base_url, headers, transformedRequest);
    logInfo(`响应状态: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`端点错误: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `端点返回 ${response.status}`,
        details: errorText,
      });
    }

    const isStreaming = transformedRequest.stream === true;

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      if (model.type === 'common') {
        // common 类型直接转发流式响应
        try {
          for await (const chunk of response.body) {
            res.write(chunk);
          }
          res.end();
          logInfo('流式响应已转发 (common 类型)');
        } catch (streamError) {
          logError('流式传输错误', streamError);
          res.end();
        }
      } else {
        // anthropic / openai 类型使用转换器
        let transformer;
        if (model.type === 'anthropic') {
          transformer = new AnthropicResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        } else if (model.type === 'openai') {
          transformer = new OpenAIResponseTransformer(modelId, `chatcmpl-${Date.now()}`);
        }

        try {
          for await (const chunk of transformer.transformStream(response.body)) {
            res.write(chunk);
          }
          res.end();
          logInfo('流式响应已完成');
        } catch (streamError) {
          logError('流式传输错误', streamError);
          res.end();
        }
      }
    } else {
      // 非流式响应 - 统一转换为 chat/completions 格式
      const data = await response.json();
      if (model.type === 'openai') {
        try {
          const converted = convertResponseToChatCompletion(data);
          logResponse(200, null, converted);
          res.json(converted);
        } catch (e) {
          logResponse(200, null, data);
          res.json(data);
        }
      } else if (model.type === 'anthropic') {
        try {
          const converted = convertAnthropicToChatCompletion(data);
          logResponse(200, null, converted);
          res.json(converted);
        } catch (e) {
          // 转换失败时回退为原始数据
          logError('Anthropic 响应格式转换失败，返回原始数据', e);
          logResponse(200, null, data);
          res.json(data);
        }
      } else {
        // common 类型本身就是 OpenAI 格式，直接返回
        logResponse(200, null, data);
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
 * 仅支持 openai 类型端点的模型
 */
async function handleDirectResponses(req, res) {
  logInfo('POST /v1/responses');

  try {
    const openaiRequest = req.body;
    const modelId = getRedirectedModelId(openaiRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model 参数是必需的' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `模型 ${modelId} 未找到` });
    }

    if (model.type !== 'openai') {
      return res.status(400).json({
        error: '端点类型不匹配',
        message: `/v1/responses 仅支持 openai 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`,
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `端点类型 ${model.type} 未配置` });
    }

    logInfo(`直接转发到 ${model.type} 端点: ${endpoint.base_url}`);

    const authHeader = await resolveAuthHeader(req, res);
    if (!authHeader) return;

    const clientHeaders = req.headers;
    const provider = getModelProvider(modelId);
    const headers = getOpenAIHeaders(authHeader, clientHeaders, provider);

    // 注入系统提示词并更新模型ID
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...openaiRequest, model: modelId };
    if (systemPrompt) {
      modifiedRequest.instructions = modifiedRequest.instructions
        ? systemPrompt + modifiedRequest.instructions
        : systemPrompt;
    }

    // 处理推理参数
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') {
      // auto: 保持原始请求不变
    } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
      modifiedRequest.reasoning = { effort: reasoningLevel, summary: 'auto' };
    } else {
      delete modifiedRequest.reasoning;
    }

    logRequest('POST', endpoint.base_url, headers, modifiedRequest);

    const response = await proxyFetch(endpoint.base_url, headers, modifiedRequest);
    logInfo(`响应状态: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`端点错误: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `端点返回 ${response.status}`,
        details: errorText,
      });
    }

    const isStreaming = openaiRequest.stream === true;

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        for await (const chunk of response.body) {
          res.write(chunk);
        }
        res.end();
        logInfo('流式响应已成功转发');
      } catch (streamError) {
        logError('流式传输错误', streamError);
        res.end();
      }
    } else {
      const data = await response.json();
      logResponse(200, null, data);
      res.json(data);
    }
  } catch (error) {
    logError('/v1/responses 处理出错', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

/**
 * POST /v1/messages - 直接转发到 Anthropic Messages API
 * 仅支持 anthropic 类型端点的模型
 */
async function handleDirectMessages(req, res) {
  logInfo('POST /v1/messages');

  try {
    const anthropicRequest = req.body;
    const modelId = getRedirectedModelId(anthropicRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model 参数是必需的' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `模型 ${modelId} 未找到` });
    }

    if (model.type !== 'anthropic') {
      return res.status(400).json({
        error: '端点类型不匹配',
        message: `/v1/messages 仅支持 anthropic 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`,
      });
    }

    const endpoint = getEndpointByType(model.type);
    if (!endpoint) {
      return res.status(500).json({ error: `端点类型 ${model.type} 未配置` });
    }

    logInfo(`直接转发到 ${model.type} 端点: ${endpoint.base_url}`);

    const authHeader = await resolveAuthHeader(req, res);
    if (!authHeader) return;

    const clientHeaders = req.headers;
    const provider = getModelProvider(modelId);
    const isStreaming = anthropicRequest.stream === true;
    const headers = getAnthropicHeaders(authHeader, clientHeaders, isStreaming, modelId, provider);

    // 注入系统提示词并更新模型ID
    const systemPrompt = getSystemPrompt();
    const modifiedRequest = { ...anthropicRequest, model: modelId };
    if (systemPrompt) {
      if (modifiedRequest.system && Array.isArray(modifiedRequest.system)) {
        modifiedRequest.system = [
          { type: 'text', text: systemPrompt },
          ...modifiedRequest.system,
        ];
      } else {
        modifiedRequest.system = [{ type: 'text', text: systemPrompt }];
      }
    }

    // 处理推理参数 (thinking)
    const reasoningLevel = getModelReasoning(modelId);
    if (reasoningLevel === 'auto') {
      // auto: 保持原始请求不变
    } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
      const budgetTokens = { low: 4096, medium: 12288, high: 24576, xhigh: 40960 };
      modifiedRequest.thinking = {
        type: 'enabled',
        budget_tokens: budgetTokens[reasoningLevel],
      };
    } else {
      delete modifiedRequest.thinking;
    }

    logRequest('POST', endpoint.base_url, headers, modifiedRequest);

    const response = await proxyFetch(endpoint.base_url, headers, modifiedRequest);
    logInfo(`响应状态: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`端点错误: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `端点返回 ${response.status}`,
        details: errorText,
      });
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        for await (const chunk of response.body) {
          res.write(chunk);
        }
        res.end();
        logInfo('流式响应已成功转发');
      } catch (streamError) {
        logError('流式传输错误', streamError);
        res.end();
      }
    } else {
      const data = await response.json();
      logResponse(200, null, data);
      res.json(data);
    }
  } catch (error) {
    logError('/v1/messages 处理出错', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

/**
 * POST /v1/messages/count_tokens - Anthropic 计算 token 数
 */
async function handleCountTokens(req, res) {
  logInfo('POST /v1/messages/count_tokens');

  try {
    const anthropicRequest = req.body;
    const modelId = getRedirectedModelId(anthropicRequest.model);

    if (!modelId) {
      return res.status(400).json({ error: 'model 参数是必需的' });
    }

    const model = getModelById(modelId);
    if (!model) {
      return res.status(404).json({ error: `模型 ${modelId} 未找到` });
    }

    if (model.type !== 'anthropic') {
      return res.status(400).json({
        error: '端点类型不匹配',
        message: `/v1/messages/count_tokens 仅支持 anthropic 类型端点，当前模型 ${modelId} 是 ${model.type} 类型`,
      });
    }

    const endpoint = getEndpointByType('anthropic');
    if (!endpoint) {
      return res.status(500).json({ error: '端点类型 anthropic 未配置' });
    }

    const authHeader = await resolveAuthHeader(req, res);
    if (!authHeader) return;

    const clientHeaders = req.headers;
    const provider = getModelProvider(modelId);
    const headers = getAnthropicHeaders(authHeader, clientHeaders, false, modelId, provider);

    // 构建 count_tokens 端点 URL
    const countTokensUrl = endpoint.base_url.replace('/v1/messages', '/v1/messages/count_tokens');
    const modifiedRequest = { ...anthropicRequest, model: modelId };

    logInfo(`转发到 count_tokens 端点: ${countTokensUrl}`);
    logRequest('POST', countTokensUrl, headers, modifiedRequest);

    const response = await proxyFetch(countTokensUrl, headers, modifiedRequest);
    logInfo(`响应状态: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`count_tokens 错误: ${response.status}`, new Error(errorText));
      return res.status(response.status).json({
        error: `端点返回 ${response.status}`,
        details: errorText,
      });
    }

    const data = await response.json();
    logResponse(200, null, data);
    res.json(data);
  } catch (error) {
    logError('/v1/messages/count_tokens 处理出错', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

// ======================== 注册路由 ========================

router.post('/v1/chat/completions', handleChatCompletions);
router.post('/v1/responses', handleDirectResponses);
router.post('/v1/messages', handleDirectMessages);
router.post('/v1/messages/count_tokens', handleCountTokens);

export default router;
