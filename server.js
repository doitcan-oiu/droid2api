/**
 * @file 服务器入口
 * @description droid2api 应用启动入口
 *              负责加载配置、初始化各服务模块、启动 HTTP 服务器
 */

import { loadConfig, getPort, isDevMode, initHotReload, onConfigChange } from './src/config/index.js';
import { logInfo, logError } from './src/utils/logger.js';
import { initializeAuth } from './src/services/auth.js';
import { initializeUserAgentUpdater } from './src/services/user-agent-updater.js';
import app from './src/app.js';

(async () => {
  try {
    // 1. 加载配置文件
    loadConfig();
    logInfo('配置文件加载成功');
    logInfo(`开发模式: ${isDevMode()}`);

    // 2. 启用配置热加载
    initHotReload();

    // 3. 注册认证配置变更回调 - 配置文件修改后自动重新初始化认证
    onConfigChange(async (newConfig, oldConfig) => {
      const authChanged =
        JSON.stringify(oldConfig.auth || {}) !== JSON.stringify(newConfig.auth || {});

      if (authChanged) {
        logInfo('检测到认证配置变更，正在重新初始化认证系统...');
        try {
          await initializeAuth(true);
        } catch (error) {
          logError('热加载认证系统失败', error);
        }
      }
    });

    // 4. 初始化 User-Agent 版本更新器
    initializeUserAgentUpdater();

    // 5. 初始化认证系统
    await initializeAuth();

    // 6. 启动 HTTP 服务器
    const PORT = getPort();
    logInfo(`正在启动服务器，端口: ${PORT}...`);

    const server = app
      .listen(PORT)
      .on('listening', () => {
        logInfo(`服务器已启动: http://localhost:${PORT}`);
        logInfo('可用端点:');
        logInfo('  GET  /v1/models');
        logInfo('  POST /v1/chat/completions');
        logInfo('  POST /v1/responses');
        logInfo('  POST /v1/messages');
        logInfo('  POST /v1/messages/count_tokens');
      })
      .on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`\n${'='.repeat(80)}`);
          console.error(`错误: 端口 ${PORT} 已被占用！`);
          console.error('');
          console.error('请选择以下操作之一:');
          console.error(`  1. 停止占用端口 ${PORT} 的进程:`);
          console.error(`     lsof -ti:${PORT} | xargs kill`);
          console.error('');
          console.error('  2. 修改配置文件 config/app.yaml 中的 port 字段');
          console.error(`${'='.repeat(80)}\n`);
          process.exit(1);
        } else {
          logError('服务器启动失败', err);
          process.exit(1);
        }
      });
  } catch (error) {
    logError('服务器启动失败', error);
    process.exit(1);
  }
})();
