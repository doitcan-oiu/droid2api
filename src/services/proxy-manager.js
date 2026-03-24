/**
 * @file 代理管理模块
 * @description 管理 HTTP 代理池，支持多代理轮询
 *              当配置发生变化时自动重置轮询索引
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyConfigs } from '../config/index.js';
import { logInfo, logError, logDebug } from '../utils/logger.js';

/** 当前代理轮询索引 */
let proxyIndex = 0;
/** 上次代理配置快照（用于检测变化） */
let lastSnapshot = '';

/**
 * 对代理配置列表生成快照字符串
 * @param {Array} configs - 代理配置数组
 * @returns {string} JSON 快照
 */
function snapshotConfigs(configs) {
  try {
    return JSON.stringify(configs);
  } catch (error) {
    logDebug('生成代理配置快照失败', { error: error.message });
    return '';
  }
}

/**
 * 获取下一个可用的代理 Agent（轮询模式）
 * @param {string} targetUrl - 目标请求地址
 * @returns {object|null} { agent, proxy } 或 null（无代理时直连）
 */
export function getNextProxyAgent(targetUrl) {
  const proxies = getProxyConfigs();

  if (!Array.isArray(proxies) || proxies.length === 0) {
    return null;
  }

  // 检测代理配置是否发生变化，变化时重置索引
  const currentSnapshot = snapshotConfigs(proxies);
  if (currentSnapshot !== lastSnapshot) {
    proxyIndex = 0;
    lastSnapshot = currentSnapshot;
    logInfo('代理配置已变更，轮询索引已重置');
  }

  // 尝试从当前索引开始查找可用代理
  for (let attempt = 0; attempt < proxies.length; attempt += 1) {
    const index = (proxyIndex + attempt) % proxies.length;
    const proxy = proxies[index];

    if (!proxy || typeof proxy.url !== 'string' || proxy.url.trim() === '') {
      logError('遇到无效的代理配置', new Error(`索引 ${index} 处的代理缺少 url 字段`));
      continue;
    }

    try {
      const agent = new HttpsProxyAgent(proxy.url);
      proxyIndex = (index + 1) % proxies.length;

      const label = proxy.name || proxy.url;
      logInfo(`使用代理 ${label} 请求 ${targetUrl}`);

      return { agent, proxy };
    } catch (error) {
      logError(`创建代理 Agent 失败: ${proxy.url}`, error);
    }
  }

  logError('所有已配置的代理均初始化失败', new Error('代理初始化失败'));
  return null;
}
