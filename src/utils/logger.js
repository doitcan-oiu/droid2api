/**
 * @file 日志工具模块
 * @description 提供统一的日志输出方法，支持分级日志：INFO / DEBUG / ERROR
 *              DEBUG 级别仅在开发模式(dev_mode)下输出
 */

import { isDevMode } from '../config/index.js';

/**
 * 输出信息级别日志
 * @param {string} message - 日志消息
 * @param {*} [data] - 附加数据（开发模式下输出）
 */
export function logInfo(message, data = null) {
  console.log(`[INFO] ${message}`);
  if (data && isDevMode()) {
    console.log(JSON.stringify(data, null, 2));
  }
}

/**
 * 输出调试级别日志（仅开发模式）
 * @param {string} message - 日志消息
 * @param {*} [data] - 附加数据
 */
export function logDebug(message, data = null) {
  if (isDevMode()) {
    console.log(`[DEBUG] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }
}

/**
 * 输出错误级别日志
 * @param {string} message - 错误消息
 * @param {Error|*} [error] - 错误对象
 */
export function logError(message, error = null) {
  console.error(`[ERROR] ${message}`);
  if (error) {
    if (isDevMode()) {
      console.error(error);
    } else {
      console.error(error.message || error);
    }
  }
}

/**
 * 记录 HTTP 请求日志
 * @param {string} method - HTTP 方法
 * @param {string} url - 请求地址
 * @param {object} [headers] - 请求头
 * @param {object} [body] - 请求体
 */
export function logRequest(method, url, headers = null, body = null) {
  if (isDevMode()) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[REQUEST] ${method} ${url}`);
    if (headers) {
      console.log('[HEADERS]', JSON.stringify(headers, null, 2));
    }
    if (body) {
      console.log('[BODY]', JSON.stringify(body, null, 2));
    }
    console.log('='.repeat(80) + '\n');
  } else {
    console.log(`[REQUEST] ${method} ${url}`);
  }
}

/**
 * 记录 HTTP 响应日志
 * @param {number} status - 响应状态码
 * @param {object} [headers] - 响应头
 * @param {object} [body] - 响应体
 */
export function logResponse(status, headers = null, body = null) {
  if (isDevMode()) {
    console.log(`\n${'-'.repeat(80)}`);
    console.log(`[RESPONSE] 状态码: ${status}`);
    if (headers) {
      console.log('[HEADERS]', JSON.stringify(headers, null, 2));
    }
    if (body) {
      console.log('[BODY]', JSON.stringify(body, null, 2));
    }
    console.log('-'.repeat(80) + '\n');
  } else {
    console.log(`[RESPONSE] 状态码: ${status}`);
  }
}
