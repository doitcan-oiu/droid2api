/**
 * @file Anthropic 响应转换器
 * @description 将 Anthropic SSE 流式响应转换为 OpenAI chat/completions 流式格式
 *              完整支持: text / tool_use / thinking 类型的内容块
 *
 *  Anthropic 事件流:
 *    message_start → content_block_start → content_block_delta(s) → content_block_stop → ... → message_delta → message_stop
 *
 *  OpenAI chunk 格式:
 *    { choices: [{ delta: { role, content, tool_calls }, finish_reason }] }
 */

import { logDebug } from '../utils/logger.js';

export class AnthropicResponseTransformer {
  /**
   * @param {string} model - 模型ID
   * @param {string} requestId - 请求ID
   */
  constructor(model, requestId) {
    this.model = model;
    this.requestId = requestId || `chatcmpl-${Date.now()}`;
    this.created = Math.floor(Date.now() / 1000);

    /** 当前正在处理的内容块类型: 'text' | 'tool_use' | 'thinking' | null */
    this.currentBlockType = null;
    /** 当前 tool_use 块在 tool_calls 数组中的索引 */
    this.toolCallIndex = -1;
    /** 当前 tool_use 块的信息 */
    this.currentToolCall = null;
  }

  /**
   * 解析 SSE 行
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
   * 将 Anthropic 事件转换为 OpenAI chunk
   * @param {string} eventType - Anthropic 事件类型
   * @param {object} eventData - 事件数据
   * @returns {string|null} OpenAI SSE 格式字符串
   */
  transformEvent(eventType, eventData) {
    logDebug(`Anthropic 事件: ${eventType}`);

    // ---- 消息开始 ----
    if (eventType === 'message_start') {
      return this.createChunk({ role: 'assistant' });
    }

    // ---- 内容块开始 ----
    if (eventType === 'content_block_start') {
      const block = eventData.content_block;
      this.currentBlockType = block?.type || null;

      if (block?.type === 'tool_use') {
        // tool_use 块开始：发送 tool_calls 初始信息（id + 函数名）
        this.toolCallIndex++;
        this.currentToolCall = {
          id: block.id || `call_${Date.now()}`,
          name: block.name || '',
        };
        return this.createChunk({
          tool_calls: [
            {
              index: this.toolCallIndex,
              id: this.currentToolCall.id,
              type: 'function',
              function: {
                name: this.currentToolCall.name,
                arguments: '',
              },
            },
          ],
        });
      }

      // text / thinking 块开始时不需要发送数据
      return null;
    }

    // ---- 内容块增量 ----
    if (eventType === 'content_block_delta') {
      const delta = eventData.delta;

      // 文本增量
      if (delta?.type === 'text_delta' && delta.text) {
        return this.createChunk({ content: delta.text });
      }

      // 兼容旧格式：直接有 text 字段
      if (delta?.text && !delta?.type) {
        return this.createChunk({ content: delta.text });
      }

      // tool_use 增量：发送函数参数的增量 JSON
      if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
        return this.createChunk({
          tool_calls: [
            {
              index: this.toolCallIndex,
              function: {
                arguments: delta.partial_json,
              },
            },
          ],
        });
      }

      // thinking 增量：跳过（OpenAI 格式没有对应字段）
      if (delta?.type === 'thinking_delta') {
        return null;
      }

      // 签名增量 (thinking 签名)：跳过
      if (delta?.type === 'signature_delta') {
        return null;
      }

      return null;
    }

    // ---- 内容块结束 ----
    if (eventType === 'content_block_stop') {
      this.currentBlockType = null;
      return null;
    }

    // ---- 消息增量（包含 stop_reason） ----
    if (eventType === 'message_delta') {
      const stopReason = eventData.delta?.stop_reason;
      if (stopReason) {
        return this.createChunk({
          finish_reason: this.mapStopReason(stopReason),
        });
      }
      return null;
    }

    // ---- 消息结束 ----
    if (eventType === 'message_stop') {
      return 'data: [DONE]\n\n';
    }

    // ping 等其他事件：忽略
    return null;
  }

  /**
   * 创建 OpenAI chat.completion.chunk 格式的 SSE 数据
   * @param {object} deltaFields - delta 字段 { role?, content?, tool_calls?, finish_reason? }
   * @returns {string} SSE 格式字符串
   */
  createChunk(deltaFields) {
    const delta = {};
    const choice = { index: 0, delta, finish_reason: null };

    if (deltaFields.role) {
      delta.role = deltaFields.role;
    }
    if (deltaFields.content !== undefined) {
      delta.content = deltaFields.content;
    }
    if (deltaFields.tool_calls) {
      delta.tool_calls = deltaFields.tool_calls;
    }
    if (deltaFields.finish_reason) {
      choice.finish_reason = deltaFields.finish_reason;
    }

    const chunk = {
      id: this.requestId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [choice],
    };

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  /**
   * 映射 Anthropic stop_reason → OpenAI finish_reason
   */
  mapStopReason(anthropicReason) {
    const mapping = {
      end_turn: 'stop',
      max_tokens: 'length',
      stop_sequence: 'stop',
      tool_use: 'tool_calls',
    };
    return mapping[anthropicReason] || 'stop';
  }

  /**
   * 转换流式响应（异步生成器）
   * @param {ReadableStream} sourceStream - Anthropic 原始响应流
   * @yields {string} OpenAI SSE 格式的数据块
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
            currentEvent = null;
          }
        }
      }
    } catch (error) {
      logDebug('Anthropic 流转换出错', error);
      throw error;
    }
  }
}
