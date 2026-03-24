/**
 * @file CORS 跨域中间件
 * @description 处理跨域资源共享，允许所有来源访问 API
 */

/**
 * CORS 中间件
 * 设置跨域响应头，处理 OPTIONS 预检请求
 */
export function corsMiddleware(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key, anthropic-version'
  );

  // 预检请求直接返回 200
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
}
