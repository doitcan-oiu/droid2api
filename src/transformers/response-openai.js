/**
 * @file OpenAI 响应转换器
 * @description 将 OpenAI Responses API 的 SSE 流式响应转换为 chat/completions 流式格式
 *              处理事件映射: response.created -> role, response.output_text.delta -> content
 */

import { logDebug } from '../utils/logger.js';

/**
 * OpenAI Responses API 流式响应转换器
 * 将 OpenAI Responses 的 SSE 事件流转换为 chat.completion.chunk 格式
 */
export class OpenAIResponseTransformer {
  /**
   * @param {string} model - 模型ID
   * @param {string} requestId - 请求ID（用于生成 chunk id）
   */
  constructor(model, requestId) {
    this.model = model;
    this.requestId = requestId || `chatcmpl-${Date.now()}`;
    this.created = Math.floor(Date.now() / 1000);
  }

  /**
   * 解析 SSE 行
   * @param {string} line - SSE 数据行
   * @returns {object|null} { type: 'event'|'data', value: * }
   */
  parseSSELine(line) {
    if (line.startsWith('event:')) {
      return { type: 'event', value: line.slice(6).trim() };
    }
    if (line.startsWith('data:')) {
      const dataStr = line.slice(5).trim();
      try {
        return { type: 'data', value: JSON.parse(dataStr) };
      } catch (e) {
        return { type: 'data', value: dataStr };
      }
    }
    return null;
  }

  /**
   * 将 OpenAI Responses 事件转换为 chat/completions chunk
   * @param {string} eventType - 事件类型
   * @param {object} eventData - 事件数据
   * @returns {string|null} SSE 格式字符串
   */
  transformEvent(eventType, eventData) {
    logDebug(`OpenAI Responses 事件: ${eventType}`);

    if (eventType === 'response.created') {
      return this.createOpenAIChunk('', 'assistant', false);
    }

    if (eventType === 'response.in_progress') return null;

    if (eventType === 'response.output_text.delta') {
      const text = eventData.delta || eventData.text || '';
      return this.createOpenAIChunk(text, null, false);
    }

    if (eventType === 'response.output_text.done') return null;

    if (eventType === 'response.done') {
      const status = eventData.response?.status;
      let finishReason = 'stop';

      if (status === 'completed') finishReason = 'stop';
      else if (status === 'incomplete') finishReason = 'length';

      const finalChunk = this.createOpenAIChunk('', null, true, finishReason);
      const done = this.createDoneSignal();
      return finalChunk + done;
    }

    return null;
  }

  /**
   * 创建 OpenAI 格式的 SSE chunk
   */
  createOpenAIChunk(content, role = null, finish = false, finishReason = null) {
    const chunk = {
      id: this.requestId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finish ? finishReason : null,
        },
      ],
    };

    if (role) chunk.choices[0].delta.role = role;
    if (content) chunk.choices[0].delta.content = content;

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  /** 生成结束信号 */
  createDoneSignal() {
    return 'data: [DONE]\n\n';
  }

  /**
   * 转换流式响应（异步生成器）
   * @param {ReadableStream} sourceStream - OpenAI Responses 原始响应流
   * @yields {string} chat/completions SSE 格式的数据块
   */
  async *transformStream(sourceStream) {
    let buffer = '';
    let currentEvent = null;

    try {
      for await (const chunk of sourceStream) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          const parsed = this.parseSSELine(line);
          if (!parsed) continue;

          if (parsed.type === 'event') {
            currentEvent = parsed.value;
          } else if (parsed.type === 'data' && currentEvent) {
            const transformed = this.transformEvent(currentEvent, parsed.value);
            if (transformed) yield transformed;
          }
        }
      }

      // 确保流结束时发送 DONE 信号
      if (currentEvent === 'response.done' || currentEvent === 'response.completed') {
        yield this.createDoneSignal();
      }
    } catch (error) {
      logDebug('OpenAI 流转换出错', error);
      throw error;
    }
  }
}
