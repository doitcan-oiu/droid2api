/**
 * @file OpenAI 请求转换器
 * @description 将标准 OpenAI chat/completions 格式转换为 OpenAI Responses API 格式
 *              处理消息格式、系统提示词注入、推理参数配置、请求头生成
 */

import { logDebug } from '../utils/logger.js';
import { getSystemPrompt, getModelReasoning, getUserAgent } from '../config/index.js';
import { generateUUID } from '../utils/id-generator.js';

/**
 * 将 OpenAI chat/completions 格式转换为 Responses API 格式
 * @param {object} openaiRequest - 标准 OpenAI 格式的请求
 * @returns {object} Responses API 格式的请求
 */
export function transformToOpenAI(openaiRequest) {
  logDebug('正在将 OpenAI 请求转换为 Responses API 格式');

  const targetRequest = {
    model: openaiRequest.model,
    input: [],
    store: false,
  };

  // 仅在客户端明确指定时传递 stream 参数
  if (openaiRequest.stream !== undefined) {
    targetRequest.stream = openaiRequest.stream;
  }

  // 转换 max_tokens -> max_output_tokens
  if (openaiRequest.max_tokens) {
    targetRequest.max_output_tokens = openaiRequest.max_tokens;
  } else if (openaiRequest.max_completion_tokens) {
    targetRequest.max_output_tokens = openaiRequest.max_completion_tokens;
  }

  // 转换消息格式: messages -> input
  if (openaiRequest.messages && Array.isArray(openaiRequest.messages)) {
    for (const msg of openaiRequest.messages) {
      const inputMsg = { role: msg.role, content: [] };

      // 根据角色决定内容类型前缀
      const textType = msg.role === 'assistant' ? 'output_text' : 'input_text';
      const imageType = msg.role === 'assistant' ? 'output_image' : 'input_image';

      if (typeof msg.content === 'string') {
        inputMsg.content.push({ type: textType, text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            inputMsg.content.push({ type: textType, text: part.text });
          } else if (part.type === 'image_url') {
            inputMsg.content.push({ type: imageType, image_url: part.image_url });
          } else {
            inputMsg.content.push(part);
          }
        }
      }

      targetRequest.input.push(inputMsg);
    }
  }

  // 转换工具定义
  if (openaiRequest.tools && Array.isArray(openaiRequest.tools)) {
    targetRequest.tools = openaiRequest.tools.map((tool) => ({
      ...tool,
      strict: false,
    }));
  }

  // 提取系统消息作为 instructions，并注入系统提示词
  const systemPrompt = getSystemPrompt();
  const systemMessage = openaiRequest.messages?.find((m) => m.role === 'system');

  if (systemMessage) {
    let userInstructions = '';
    if (typeof systemMessage.content === 'string') {
      userInstructions = systemMessage.content;
    } else if (Array.isArray(systemMessage.content)) {
      userInstructions = systemMessage.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
    }
    targetRequest.instructions = systemPrompt + userInstructions;
    // 从 input 中移除系统消息
    targetRequest.input = targetRequest.input.filter((m) => m.role !== 'system');
  } else if (systemPrompt) {
    targetRequest.instructions = systemPrompt;
  }

  // 处理推理(reasoning)参数
  const reasoningLevel = getModelReasoning(openaiRequest.model);
  if (reasoningLevel === 'auto') {
    // auto 模式：保留客户端原始 reasoning 设置
    if (openaiRequest.reasoning !== undefined) {
      targetRequest.reasoning = openaiRequest.reasoning;
    }
  } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
    // 指定级别：覆盖为配置值
    targetRequest.reasoning = { effort: reasoningLevel, summary: 'auto' };
  } else {
    // off 或无效值：移除 reasoning 字段
    delete targetRequest.reasoning;
  }

  // 透传兼容参数
  if (openaiRequest.temperature !== undefined) {
    targetRequest.temperature = openaiRequest.temperature;
  }
  if (openaiRequest.top_p !== undefined) {
    targetRequest.top_p = openaiRequest.top_p;
  }
  if (openaiRequest.presence_penalty !== undefined) {
    targetRequest.presence_penalty = openaiRequest.presence_penalty;
  }
  if (openaiRequest.frequency_penalty !== undefined) {
    targetRequest.frequency_penalty = openaiRequest.frequency_penalty;
  }
  if (openaiRequest.parallel_tool_calls !== undefined) {
    targetRequest.parallel_tool_calls = openaiRequest.parallel_tool_calls;
  }

  logDebug('OpenAI Responses API 请求转换完成', targetRequest);
  return targetRequest;
}

/**
 * 生成 OpenAI API 请求头
 * @param {string} authHeader - 认证头
 * @param {object} clientHeaders - 客户端原始请求头
 * @param {string} provider - 提供商标识
 * @returns {object} 请求头对象
 */
export function getOpenAIHeaders(authHeader, clientHeaders = {}, provider = 'openai') {
  const sessionId = clientHeaders['x-session-id'] || generateUUID();
  const messageId = clientHeaders['x-assistant-message-id'] || generateUUID();

  const headers = {
    'content-type': 'application/json',
    authorization: authHeader || '',
    'x-api-provider': provider,
    'x-factory-client': 'cli',
    'x-session-id': sessionId,
    'x-assistant-message-id': messageId,
    'user-agent': getUserAgent(),
    connection: 'keep-alive',
  };

  // Stainless SDK 默认头
  const stainlessDefaults = {
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'MacOS',
    'x-stainless-runtime': 'node',
    'x-stainless-retry-count': '0',
    'x-stainless-package-version': '5.23.2',
    'x-stainless-runtime-version': 'v24.3.0',
  };

  Object.keys(stainlessDefaults).forEach((header) => {
    headers[header] = clientHeaders[header] || stainlessDefaults[header];
  });

  return headers;
}
