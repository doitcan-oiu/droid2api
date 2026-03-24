/**
 * @file 错误处理中间件
 * @description 统一处理 404 和 500 错误，输出结构化错误信息
 */

import { logError } from '../utils/logger.js';
import { isDevMode } from '../config/index.js';

/** 可用的 API 端点列表 */
const AVAILABLE_ENDPOINTS = [
  'GET  /v1/models',
  'POST /v1/chat/completions',
  'POST /v1/responses',
  'POST /v1/messages',
  'POST /v1/messages/count_tokens',
];

/**
 * 404 处理中间件 - 捕获所有未匹配的路由
 */
export function notFoundHandler(req, res, next) {
  const errorInfo = {
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.path,
    query: req.query,
    body: req.body,
    headers: {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent'],
      origin: req.headers['origin'],
      referer: req.headers['referer'],
    },
    ip: req.ip || req.connection?.remoteAddress,
  };

  console.error('\n' + '='.repeat(80));
  console.error('❌ 非法请求地址');
  console.error('='.repeat(80));
  console.error(`时间: ${errorInfo.timestamp}`);
  console.error(`方法: ${errorInfo.method}`);
  console.error(`地址: ${errorInfo.url}`);
  console.error(`路径: ${errorInfo.path}`);

  if (Object.keys(errorInfo.query).length > 0) {
    console.error(`查询参数: ${JSON.stringify(errorInfo.query, null, 2)}`);
  }
  if (errorInfo.body && Object.keys(errorInfo.body).length > 0) {
    console.error(`请求体: ${JSON.stringify(errorInfo.body, null, 2)}`);
  }

  console.error(`客户端IP: ${errorInfo.ip}`);
  console.error(`User-Agent: ${errorInfo.headers['user-agent'] || 'N/A'}`);
  if (errorInfo.headers.referer) {
    console.error(`来源: ${errorInfo.headers.referer}`);
  }
  console.error('='.repeat(80) + '\n');

  logError('非法请求路径', errorInfo);

  res.status(404).json({
    error: 'Not Found',
    message: `路径 ${req.method} ${req.path} 不存在`,
    timestamp: errorInfo.timestamp,
    availableEndpoints: AVAILABLE_ENDPOINTS,
  });
}

/**
 * 500 错误处理中间件 - 捕获未处理的异常
 */
export function errorHandler(err, req, res, next) {
  logError('未处理的异常', err);
  res.status(500).json({
    error: 'Internal server error',
    message: isDevMode() ? err.message : undefined,
  });
}
