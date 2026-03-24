/**
 * @file 通用请求转换器
 * @description 处理 Common 类型端点（如 Gemini、GLM 等）的请求转换
 *              基本保持 OpenAI 格式，仅注入系统提示词和推理参数
 */

import { logDebug } from '../utils/logger.js';
import { getSystemPrompt, getUserAgent, getModelReasoning } from '../config/index.js';
import { generateUUID } from '../utils/id-generator.js';

/**
 * 将 OpenAI 格式请求转换为 Common 端点格式
 * 基本保持原格式，仅在 messages 中注入系统提示词
 * @param {object} openaiRequest - OpenAI 格式的请求
 * @returns {object} Common 格式的请求
 */
export function transformToCommon(openaiRequest) {
  logDebug('正在转换为 Common 请求格式');

  const commonRequest = { ...openaiRequest };
  const systemPrompt = getSystemPrompt();

  if (systemPrompt) {
    const hasSystemMessage = commonRequest.messages?.some((m) => m.role === 'system');

    if (hasSystemMessage) {
      // 如果已有系统消息，将提示词前置到第一个系统消息
      commonRequest.messages = commonRequest.messages.map((msg, index) => {
        if (
          msg.role === 'system' &&
          index === commonRequest.messages.findIndex((m) => m.role === 'system')
        ) {
          return {
            role: 'system',
            content: systemPrompt + (typeof msg.content === 'string' ? msg.content : ''),
          };
        }
        return msg;
      });
    } else {
      // 没有系统消息时，在 messages 数组最前面插入
      commonRequest.messages = [
        { role: 'system', content: systemPrompt },
        ...(commonRequest.messages || []),
      ];
    }
  }

  // 处理推理级别参数 (reasoning_effort)
  const reasoningLevel = getModelReasoning(openaiRequest.model);
  if (reasoningLevel === 'auto') {
    // auto 模式：保留客户端原始设置
  } else if (reasoningLevel && ['low', 'medium', 'high', 'xhigh'].includes(reasoningLevel)) {
    commonRequest.reasoning_effort = reasoningLevel;
  } else {
    delete commonRequest.reasoning_effort;
  }

  logDebug('Common 请求转换完成', commonRequest);
  return commonRequest;
}

/**
 * 生成 Common 端点请求头
 * @param {string} authHeader - 认证头
 * @param {object} clientHeaders - 客户端原始请求头
 * @param {string} provider - 提供商标识
 * @returns {object} 请求头对象
 */
export function getCommonHeaders(authHeader, clientHeaders = {}, provider = 'baseten') {
  const sessionId = clientHeaders['x-session-id'] || generateUUID();
  const messageId = clientHeaders['x-assistant-message-id'] || generateUUID();

  const headers = {
    accept: 'application/json',
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
