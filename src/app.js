/**
 * @file Express 应用实例
 * @description 创建并配置 Express 应用，挂载中间件和路由
 */

import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import router from './routes/api.js';
import { corsMiddleware } from './middleware/cors.js';
import { notFoundHandler, errorHandler } from './middleware/error-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ======================== 中间件 ========================

// 请求体解析（支持最大 50MB）
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 跨域处理
app.use(corsMiddleware);

// API 路由
app.use(router);

// 令牌管理页面
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'auth-admin.html'));
});

// 根路径 - 服务信息
app.get('/', (req, res) => {
  res.json({
    name: 'droid2api',
    version: '2.0.0',
    description: 'OpenAI 兼容的 API 代理服务',
    endpoints: [
      'GET  /v1/models',
      'POST /v1/chat/completions',
      'POST /v1/responses',
      'POST /v1/messages',
      'POST /v1/messages/count_tokens',
    ],
  });
});

// 错误处理
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
