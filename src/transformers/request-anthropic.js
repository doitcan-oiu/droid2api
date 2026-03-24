/**
 * @file Anthropic 请求转换器
 * @description 将 OpenAI 格式的请求转换为 Anthropic API 格式
 *              处理消息格式、系统提示词注入、推理参数配置、请求头生成
 */

import { logDebug } from '../utils/logger.js';
import { getSystemPrompt, getModelReasoning, getUserAgent } from '../config/index.js';
import { generateUUID } from '../utils/id-generator.js';

/**
 * 将 OpenAI 格式的请求体转换为 Anthropic API 格式
 * @param {object} openaiRequest - OpenAI 格式的请求对象
 * @returns {object} Anthropic 格式的请求对象
 */
export function transformToAnthropic(openaiRequest) {
  logDebug('正在将 OpenAI 请求转换为 Anthropic 格式');

  const anthropicRequest = {
    model: openaiRequest.model,
    messages: [],
  };

  // 仅在客户端明确指定时传递 stream 参数
  if (openaiRequest.stream !== undefined) {
    anthropicRequest.stream = openaiRequest.stream;
  }

  // 处理 max_tokens 参数
  if (openaiRequest.max_tokens) {
    anthropicRequest.max_tokens = openaiRequest.max_tokens;
  } else if (openaiRequest.max_completion_tokens) {
    anthropicRequest.max_tokens = openaiRequest.max_completion_tokens;
  } else {
    anthropicRequest.max_tokens = 4096;
  }

  // 提取系统消息并转换其他消息
  let systemContent = [];

  if (openaiRequest.messages && Array.isArray(openaiRequest.messages)) {
    for (const msg of openaiRequest.messages) {
      // 系统消息单独处理，放到 system 字段
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemContent.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              systemContent.push({ type: 'text', text: part.text });
            } else {
              systemContent.push(part);
            }
          }
        }
        continue;
      }

      // 转换用户/助手消息
      const anthropicMsg = { role: msg.role, content: [] };

      if (typeof msg.content === 'string') {
        anthropicMsg.content.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            anthropicMsg.content.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url') {
            anthropicMsg.content.push({ type: 'image', source: part.image_url });
          } else {
            anthropicMsg.content.push(part);
          }
        }
      }

      anthropicRequest.messages.push(anthropicMsg);
    }
  }

  // 注入系统提示词（前置于用户系统消息之前）
  const systemPrompt = getSystemPrompt();
  if (systemPrompt || systemContent.length > 0) {
    anthropicRequest.system = [];
    if (systemPrompt) {
      anthropicRequest.system.push({ type: 'text', text: systemPrompt });
    }
    anthropicRequest.system.push(...systemContent);
  }

  // 转换工具定义（OpenAI -> Anthropic 格式）
  if (openaiRequest.tools && Array.isArray(openaiRequest.tools)) {
    anthropicRequest.tools = openaiRequest.tools.map((tool) => {
      if (tool.type === 'function') {
        return {
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters || {},
        };
      }
      return tool;
    });
  }

  // 处理推理(thinking)参数
  const reasoningLevel = getModelReasoning(openaiRequest.model);
  if (reasoningLevel === 'auto') {
    // auto 模式：完全保留客户端原始 thinking 设置
    if (openaiRequest.thinking !== undefined) {
      anthropicRequest.thinking = openaiRequest.thinking;
    }
  } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
    // 指定级别：按配置覆盖 thinking 参数
    const budgetTokens = { low: 4096, medium: 12288, high: 24576, xhigh: 40960 };
    anthropicRequest.thinking = {
      type: 'enabled',
      budget_tokens: budgetTokens[reasoningLevel],
    };
  } else {
    // off 或无效值：移除 thinking 字段
    delete anthropicRequest.thinking;
  }

  // 透传兼容参数
  if (openaiRequest.temperature !== undefined) {
    anthropicRequest.temperature = openaiRequest.temperature;
  }
  if (openaiRequest.top_p !== undefined) {
    anthropicRequest.top_p = openaiRequest.top_p;
  }
  if (openaiRequest.stop !== undefined) {
    anthropicRequest.stop_sequences = Array.isArray(openaiRequest.stop)
      ? openaiRequest.stop
      : [openaiRequest.stop];
  }

  logDebug('Anthropic 请求转换完成', anthropicRequest);
  return anthropicRequest;
}

/**
 * 生成 Anthropic API 请求头
 * @param {string} authHeader - 认证头
 * @param {object} clientHeaders - 客户端原始请求头
 * @param {boolean} isStreaming - 是否为流式请求
 * @param {string|null} modelId - 模型ID（用于推理相关头处理）
 * @param {string} provider - 提供商标识
 * @returns {object} 请求头对象
 */
export function getAnthropicHeaders(
  authHeader,
  clientHeaders = {},
  isStreaming = true,
  modelId = null,
  provider = 'anthropic'
) {
  const sessionId = clientHeaders['x-session-id'] || generateUUID();
  const messageId = clientHeaders['x-assistant-message-id'] || generateUUID();

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'anthropic-version': clientHeaders['anthropic-version'] || '2023-06-01',
    authorization: authHeader || '',
    'x-api-key': 'placeholder',
    'x-api-provider': provider,
    'x-factory-client': 'cli',
    'x-session-id': sessionId,
    'x-assistant-message-id': messageId,
    'user-agent': getUserAgent(),
    'x-stainless-timeout': '600',
    connection: 'keep-alive',
  };

  // 根据推理配置处理 anthropic-beta 头
  const reasoningLevel = modelId ? getModelReasoning(modelId) : null;
  let betaValues = [];

  // 保留客户端已有的 beta 值
  if (clientHeaders['anthropic-beta']) {
    betaValues = clientHeaders['anthropic-beta'].split(',').map((v) => v.trim());
  }

  const thinkingBeta = 'interleaved-thinking-2025-05-14';
  if (reasoningLevel === 'auto') {
    // auto 模式：不修改 beta 头
  } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
    // 指定级别：确保包含 thinking beta
    if (!betaValues.includes(thinkingBeta)) {
      betaValues.push(thinkingBeta);
    }
  } else {
    // off/无效：移除 thinking beta
    betaValues = betaValues.filter((v) => v !== thinkingBeta);
  }

  if (betaValues.length > 0) {
    headers['anthropic-beta'] = betaValues.join(', ');
  }

  // Stainless SDK 默认头
  const stainlessDefaults = {
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'MacOS',
    'x-stainless-runtime': 'node',
    'x-stainless-retry-count': '0',
    'x-stainless-package-version': '0.57.0',
    'x-stainless-runtime-version': 'v24.3.0',
  };

  if (isStreaming) {
    headers['x-stainless-helper-method'] = 'stream';
  }

  Object.keys(stainlessDefaults).forEach((header) => {
    headers[header] = clientHeaders[header] || stainlessDefaults[header];
  });

  if (clientHeaders['x-stainless-timeout']) {
    headers['x-stainless-timeout'] = clientHeaders['x-stainless-timeout'];
  }

  return headers;
}
